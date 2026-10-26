// Full real VMD, comparing the previous head-only preview with garment stabilization.
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Module = require('node:module'), assert = require('node:assert/strict'), THREE = require('three');
const { execFileSync } = require('node:child_process');
const { MMDPhysics } = require('three-stdlib');
const root = path.resolve(__dirname, '..');
const p95 = values => { values.sort((a, b) => a - b); return values[Math.floor(values.length * .95)]; };
function angularChatter(poses, slots, from) {
  const a = new THREE.Quaternion(), b = new THREE.Quaternion(), c = new THREE.Quaternion(), values = [];
  for (let frame = from; frame < poses.length - 1; frame++) for (const slot of slots) {
    const offset = slot * 7 + 3;
    a.fromArray(poses[frame - 1], offset); b.fromArray(poses[frame], offset); c.fromArray(poses[frame + 1], offset);
    values.push(a.slerp(c, .5).angleTo(b) * 180 / Math.PI);
  }
  return p95(values);
}
function vertexChatter(frames, from) {
  const values = [];
  for (let frame = from; frame < frames.length - 1; frame++)
    for (let k = 0; k < frames[frame].length; k += 3) {
      let squared = 0;
      for (let axis = 0; axis < 3; axis++)
        squared += (frames[frame][k + axis] - (frames[frame - 1][k + axis] + frames[frame + 1][k + axis]) / 2) ** 2;
      values.push(Math.sqrt(squared));
    }
  return p95(values);
}
// RMS excursion after a 15-frame average removes chatter and measures retained slow cloth motion.
function swing(frames, from) {
  const averages = [];
  for (let frame = from; frame + 15 <= frames.length; frame += 15) {
    const value = new Float64Array(frames[0].length);
    for (let n = 0; n < 15; n++) frames[frame + n].forEach((v, k) => { value[k] += v / 15; });
    averages.push(value);
  }
  const mean = new Float64Array(frames[0].length);
  averages.forEach(frame => frame.forEach((v, k) => { mean[k] += v / averages.length; }));
  return Math.sqrt(averages.reduce((sum, frame) =>
    sum + frame.reduce((s, v, k) => s + (v - mean[k]) ** 2, 0), 0) / (averages.length * mean.length));
}
async function run() {
  const bundle = new Module(workerData.bundle, module); bundle.filename = workerData.bundle; bundle.paths = module.paths;
  bundle._compile(fs.readFileSync(workerData.bundle, 'utf8'), workerData.bundle);
  const { buildMotionMesh, animateMotion, createPhysicsSimulation, serializePhysicsRig, PhysicsPoseCache,
    createHeadPoseStabilizer, createGarmentPoseStabilizer, PHYSICS_FPS } = bundle.exports;
  global.Ammo = await require('ammojs3/dist/ammo.wasm.js')({
    wasmBinary: fs.readFileSync(path.join(root, 'node_modules/ammojs3/dist/ammo.wasm.wasm')) });
  const bytes = fs.readFileSync(workerData.file);
  const buffer = () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const previous = buildMotionMesh(buffer()), display = buildMotionMesh(buffer());
  const input = { rig: serializePhysicsRig(previous.mesh), motion: workerData.motion };
  const fixed = createPhysicsSimulation(input), mmd = previous.mesh.geometry.userData.MMD;
  const original = new MMDPhysics(previous.mesh, mmd.rigidBodies, mmd.constraints,
    { unitStep: 1 / PHYSICS_FPS, maxStepNum: 1 });
  const head = createHeadPoseStabilizer(original, previous.mesh, 1 / PHYSICS_FPS);
  const check = createGarmentPoseStabilizer(original, previous.mesh, 1 / PHYSICS_FPS);
  const native = () => original.bodies.flatMap(body => {
    const t = body.body.getCenterOfMassTransform(), p = t.getOrigin(), q = t.getRotation();
    return [p.x(), p.y(), p.z(), q.x(), q.y(), q.z(), q.w()];
  });
  const before = native(); check.apply();
  assert.deepEqual(native(), before, 'Garment projection must not modify native bodies');
  previous.mesh.skeleton.pose(); previous.mesh.updateMatrixWorld(true);
  const originalAnimation = animateMotion(previous.mesh, previous.loader, input.motion);
  const displayAnimation = animateMotion(display.mesh, display.loader, input.motion);
  originalAnimation.sample(0); original.reset();
  const originalStep = time => { originalAnimation.sample(time); original.update(1 / PHYSICS_FPS); head.apply(); };
  const indices = new Set(check.bones), slots = fixed.indices.map((bone, slot) => ({ bone, slot }))
    .filter(({ bone }) => indices.has(bone)).map(({ slot }) => slot);
  assert(indices.size > 20, 'The authored skirt chains must be recognized');
  const skinIndex = previous.mesh.geometry.attributes.skinIndex, skinWeight = previous.mesh.geometry.attributes.skinWeight;
  const candidates = [];
  for (let vertex = 0; vertex < skinIndex.count; vertex++) {
    let weight = 0;
    for (let k = 0; k < 4; k++) if (indices.has(skinIndex.getComponent(vertex, k))) weight += skinWeight.getComponent(vertex, k);
    if (weight > .7) candidates.push(vertex);
  }
  const sampleCount = Math.min(64, candidates.length);
  const vertices = Array.from({ length: sampleCount }, (_, i) => candidates[Math.floor(i * candidates.length / sampleCount)]);
  assert(vertices.length > 20, 'Inspect actual skinned garment vertices');
  const point = new THREE.Vector3(), waist = new THREE.Matrix4(), scale = previous.mesh.geometry.boundingSphere?.radius || 20;
  const skin = mesh => {
    waist.copy(mesh.skeleton.getBoneByName('下半身').matrixWorld).invert();
    return vertices.flatMap(index => mesh.getVertexPosition(index, point).applyMatrix4(waist).divideScalar(scale).toArray());
  };
  const capturePrevious = () => {
    const values = new Float32Array(fixed.indices.length * 7);
    fixed.indices.forEach((index, slot) => {
      previous.mesh.skeleton.bones[index].position.toArray(values, slot * 7);
      previous.mesh.skeleton.bones[index].quaternion.toArray(values, slot * 7 + 3);
    });
    return values;
  };
  const roots = mmd.constraints.flatMap(joint => {
    const a = mmd.rigidBodies[joint.rigidBodyIndex1], b = mmd.rigidBodies[joint.rigidBodyIndex2];
    if (a.type !== 0 || !indices.has(b.boneIndex) || previous.mesh.skeleton.bones[b.boneIndex].parent !== previous.mesh.skeleton.bones[a.boneIndex])
      return [];
    if (![...joint.translationLimitation1, ...joint.translationLimitation2,
      ...joint.rotationLimitation1, ...joint.rotationLimitation2].every(v => v === 0)) return [];
    return [b.boneIndex];
  });
  const cache = new PhysicsPoseCache(fixed.indices.length * 7);
  const plainPoses = [], fixedPoses = [], plainSkin = [], fixedSkin = [];
  for (let n = 0; n < PHYSICS_FPS; n++) { originalStep(0); fixed.step(0); }
  const durationFrames = Math.round(input.motion.info.duration * PHYSICS_FPS);
  for (let frame = 0; frame <= durationFrames; frame++) {
    const time = frame / PHYSICS_FPS;
    if (frame) { originalStep(time); fixed.step(time); }
    const plain = capturePrevious(), stable = fixed.capture();
    assert(stable.every(Number.isFinite));
    for (let slot = 0; slot < fixed.indices.length; slot++) if (!indices.has(fixed.indices[slot]))
      assert.deepEqual(stable.slice(slot * 7, slot * 7 + 7), plain.slice(slot * 7, slot * 7 + 7),
        'Head, body and non-garment physics must remain unchanged');
    previous.mesh.updateMatrixWorld(true); previous.mesh.skeleton.update();
    displayAnimation.sample(time); cache.put(frame, 1, stable);
    assert(cache.apply(display.mesh, fixed.indices, time));
    for (const rootIndex of roots) {
      const bone = display.mesh.skeleton.bones[rootIndex], rest = input.rig.bones[rootIndex];
      assert(bone.position.distanceTo(new THREE.Vector3().fromArray(rest.position)) < .001, 'Locked waist attachment must not stretch');
      assert(bone.quaternion.angleTo(new THREE.Quaternion().fromArray(rest.quaternion)) < .001, 'Locked waist must follow body rotation');
    }
    plainPoses.push(plain); fixedPoses.push(stable); plainSkin.push(skin(previous.mesh)); fixedSkin.push(skin(display.mesh));
    assert(fixedSkin.at(-1).every(Number.isFinite));
  }
  const from = 10 * PHYSICS_FPS;
  const baseline = angularChatter(plainPoses, slots, from), stabilized = angularChatter(fixedPoses, slots, from);
  const skinBefore = vertexChatter(plainSkin, from), skinAfter = vertexChatter(fixedSkin, from);
  const swingRatio = swing(fixedSkin, from) / swing(plainSkin, from);
  console.log('GARMENT_SWAY_OK', path.basename(workerData.file), JSON.stringify({
    bones: indices.size, lockedWaist: roots.length, vertices: vertices.length,
    lateAngularP95Before: baseline, lateAngularP95After: stabilized,
    lateVertexP95Before: skinBefore, lateVertexP95After: skinAfter, slowSwingRatio: swingRatio,
  }));
  assert(stabilized < baseline * .6, 'Late angular chatter must fall without disabling physics');
  const reportedFixture = path.basename(workerData.file).includes('丽芙');
  assert(skinAfter < skinBefore * (reportedFixture ? .5 : .95),
    'Reduce the reported Liv cloth jitter by half and avoid regressing the other characters');
  assert(swingRatio > .7 && swingRatio < 1.3, 'Retain low-frequency cloth sway rather than freezing the skirt');
  // Revisiting a late frame reuses the same pose; reopening replays from the initial world.
  const atTwelve = fixedPoses[720];
  displayAnimation.sample(12); assert(cache.apply(display.mesh, fixed.indices, 12));
  const first = vertices.flatMap(i => display.mesh.getVertexPosition(i, point).toArray());
  for (const time of [0, 16, 4, 12]) { displayAnimation.sample(time); assert(cache.apply(display.mesh, fixed.indices, time)); }
  const again = vertices.flatMap(i => display.mesh.getVertexPosition(i, point).toArray());
  assert(Math.max(...first.map((v, i) => Math.abs(v - again[i]))) < 1e-5);
  const replay = createPhysicsSimulation(input);
  for (let n = 0; n < PHYSICS_FPS; n++) replay.step(0);
  for (let n = 1; n <= 720; n++) replay.step(n / PHYSICS_FPS);
  assert(Math.max(...replay.capture().map((v, i) => Math.abs(v - atTwelve[i]))) < 1e-4);
  parentPort.postMessage('done');
}
if (!isMainThread) run().catch(error => { throw error; });
else (async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-garment-test-'));
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
    for (const file of files) await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { file, bundle, motion } });
      worker.once('error', reject); worker.once('message', () => worker.terminate().then(resolve));
    });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
