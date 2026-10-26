// Compare the shipped preview against unmodified MMDPhysics on a full real VMD.
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), Module = require('node:module'), THREE = require('three');
const { execFileSync } = require('node:child_process');
const { MMDPhysics } = require('three-stdlib');
const root = path.resolve(__dirname, '..');
const headAncestor = bone => {
  for (let b = bone; b; b = b.parent) if (/^(頭|头|head)(\d+)?$/i.test(b.name)) return true;
  return false;
};
const percentile = values => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * .95)];
};
const chatter = (poses, slots) => {
  const values = [];
  const a = new THREE.Quaternion(), b = new THREE.Quaternion(), c = new THREE.Quaternion();
  for (let frame = 1; frame < poses.length - 1; frame++) for (const slot of slots) {
    const offset = slot * 7 + 3;
    a.fromArray(poses[frame - 1], offset); b.fromArray(poses[frame], offset); c.fromArray(poses[frame + 1], offset);
    values.push(a.slerp(c, .5).angleTo(b) * 180 / Math.PI);
  }
  return percentile(values);
};
async function run() {
  const bundle = new Module(workerData.bundle, module);
  bundle.filename = workerData.bundle; bundle.paths = module.paths;
  bundle._compile(fs.readFileSync(workerData.bundle, 'utf8'), workerData.bundle);
  const { buildMotionMesh, animateMotion, createPhysicsSimulation, serializePhysicsRig, PHYSICS_FPS,
    createHeadPoseStabilizer, createGarmentPoseStabilizer } = bundle.exports;
  global.Ammo = await require('ammojs3/dist/ammo.wasm.js')({
    wasmBinary: fs.readFileSync(path.join(root, 'node_modules/ammojs3/dist/ammo.wasm.wasm')) });
  const bytes = fs.readFileSync(workerData.file);
  const rig = buildMotionMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const input = { rig: serializePhysicsRig(rig.mesh), motion: workerData.motion };
  const fixed = createPhysicsSimulation(input);
  const mmd = rig.mesh.geometry.userData.MMD;
  const original = new MMDPhysics(rig.mesh, mmd.rigidBodies, mmd.constraints,
    { unitStep: 1 / PHYSICS_FPS, maxStepNum: 1 });
  // Use an independent projector to verify it never changes native transforms.
  const projector = createHeadPoseStabilizer(original, rig.mesh, 1 / PHYSICS_FPS);
  const nativeTransforms = () => original.bodies.flatMap(body => {
    const t = body.body.getCenterOfMassTransform(), p = t.getOrigin(), q = t.getRotation();
    return [p.x(), p.y(), p.z(), q.x(), q.y(), q.z(), q.w()];
  });
  const nativeBefore = nativeTransforms();
  projector.apply();
  assert.deepEqual(nativeTransforms(), nativeBefore, 'Projecting the head pose must leave native bodies untouched');
  rig.mesh.skeleton.pose(); rig.mesh.updateMatrixWorld(true);
  // Both worlds use the same garment pass; this test isolates head stabilization.
  const garment = createGarmentPoseStabilizer(original, rig.mesh, 1 / PHYSICS_FPS);
  const animation = animateMotion(rig.mesh, rig.loader, input.motion);
  animation.sample(0); original.reset();
  const originalStep = time => { animation.sample(time); original.update(1 / PHYSICS_FPS); garment.apply(); };
  const capture = () => {
    const values = new Float32Array(fixed.indices.length * 7);
    fixed.indices.forEach((i, n) => {
      rig.mesh.skeleton.bones[i].position.toArray(values, n * 7);
      rig.mesh.skeleton.bones[i].quaternion.toArray(values, n * 7 + 3);
    });
    return values;
  };
  const headSlots = fixed.indices.map((index, slot) => ({ index, slot }))
    .filter(({ index }) => headAncestor(rig.mesh.skeleton.bones[index])).map(({ slot }) => slot);
  const headSet = new Set(headSlots);
  const plain = [], stabilized = [];
  for (let n = 0; n < PHYSICS_FPS; n++) { originalStep(0); fixed.step(0); }
  const frameCount = Math.round(input.motion.info.duration * PHYSICS_FPS);
  for (let n = 1; n <= frameCount; n++) {
    originalStep(n / PHYSICS_FPS); fixed.step(n / PHYSICS_FPS);
    const before = capture(), after = fixed.capture();
    assert(after.every(Number.isFinite), `Frame ${n} must have finite head poses`);
    for (let slot = 0; slot < fixed.indices.length; slot++) if (!headSet.has(slot))
      assert.deepEqual(after.slice(slot * 7, slot * 7 + 7), before.slice(slot * 7, slot * 7 + 7),
        'Head stabilization must not interfere with the garment pass');
    plain.push(before); stabilized.push(after);
  }
  const baseline = chatter(plain, headSlots), result = chatter(stabilized, headSlots);
  console.log('HEAD_CHATTER', path.basename(workerData.file), JSON.stringify({
    frames: frameCount, headBones: headSlots.length, baselineP95Degrees: baseline,
    stabilizedP95Degrees: result, reduction: 1 - result / baseline,
  }));
  assert(result < baseline * .3, 'Continuous head chatter must fall by at least 70%');
  const changed = Math.max(...stabilized.at(-1).map((v, i) => Math.abs(v - stabilized[0][i])));
  assert(changed > .1, 'Stabilization must keep actual animation and secondary movement');
  parentPort.postMessage('done');
}
if (!isMainThread) run().catch(error => { throw error; });
else (async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-head-test-'));
  try {
    const bundle = path.join(temp, 'rig.cjs');
    require('esbuild').buildSync({ stdin: { contents: "export * from './src/motion-rig'; export * from './src/motion-physics-core'; export * from './src/motion-head-physics'; export * from './src/motion-garment-physics';", resolveDir: root },
      outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['three', 'three-stdlib'] });
    const motion = JSON.parse(execFileSync(path.join(root, '.venv/bin/python'),
      ['-c', 'import sys,json;from motion_assets import read_vmd;print(json.dumps(read_vmd(sys.argv[1])))',
        path.join(root, '../datasets/motion/EX_HAPPY/motion.vmd')], { cwd: root, maxBuffer: 32 * 1024 ** 2 }));
    const source = path.join(root, '../datasets/character_model');
    const files = fs.readdirSync(source).filter(dir => fs.statSync(path.join(source, dir)).isDirectory())
      .flatMap(dir => fs.readdirSync(path.join(source, dir)).filter(file => file.endsWith('.pmx')).map(file => path.join(source, dir, file)));
    for (const file of files.reverse()) await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { file, bundle, motion } });
      worker.once('error', reject); worker.once('message', () => worker.terminate().then(resolve));
    });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
