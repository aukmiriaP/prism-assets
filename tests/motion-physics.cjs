// Real Bullet worlds run in isolated workers, just like the viewer. Fixtures remain read-only.
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), Module = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const signature = mesh => mesh.skeleton.bones.flatMap(b => [...b.position.toArray(), ...b.quaternion.toArray()]);
const difference = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

async function test() {
  const bundle = new Module(workerData.output, module);
  bundle.filename = workerData.output; bundle.paths = module.paths;
  bundle._compile(fs.readFileSync(workerData.output, 'utf8'), workerData.output);
  const { buildMotionMesh, animateMotion, createPhysicsSimulation, serializePhysicsRig, PhysicsPoseCache } = bundle.exports;
  global.Ammo = await require('ammojs3/dist/ammo.wasm.js')({
    wasmBinary: fs.readFileSync(path.join(root, 'node_modules/ammojs3/dist/ammo.wasm.wasm')) });
  const bytes = fs.readFileSync(workerData.file);
  const rig = buildMotionMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const input = { rig: serializePhysicsRig(rig.mesh), motion: workerData.motion };
  const animation = animateMotion(rig.mesh, rig.loader, input.motion);
  const start = performance.now(), simulation = createPhysicsSimulation(input);
  const cache = new PhysicsPoseCache(simulation.indices.length * 7);
  for (let n = 0; n < 60; n++) simulation.step(0);
  for (let n = 0; n <= 301; n++) {
    if (n) simulation.step(n / 60);
    cache.put(n, 1, simulation.capture());
  }
  animation.sample(5);
  const plain = signature(rig.mesh);
  assert(cache.apply(rig.mesh, simulation.indices, 5));
  const atFive = signature(rig.mesh);
  assert(difference(plain, atFive) > .01, 'PMX physics must visibly affect the actual bones');
  const hair = simulation.indices.filter(i => /髪|hair|发|髮/i.test(rig.mesh.skeleton.bones[i].name));
  const skirt = simulation.indices.filter(i => /ｽｶｰﾄ|スカート|skirt|裙/i.test(rig.mesh.skeleton.bones[i].name));
  for (const [kind, indices] of [['hair', hair], ['skirt', skirt]]) {
    if (indices.length) assert(Math.max(...indices.flatMap(i => atFive.slice(i * 7, i * 7 + 7)
      .map((v, n) => Math.abs(v - plain[i * 7 + n])))) > .01, `${kind} bones must change`);
  }
  const physical = new Set(simulation.indices);
  for (let i = 0; i < rig.mesh.skeleton.bones.length; i++) {
    if (!physical.has(i)) assert.deepEqual(atFive.slice(i * 7, i * 7 + 7), plain.slice(i * 7, i * 7 + 7));
  }
  for (const t of [0, 2, 5, 1.001, 0, 5, 5]) {
    animation.sample(t); assert(cache.apply(rig.mesh, simulation.indices, t));
    assert(signature(rig.mesh).every(Number.isFinite));
  }
  assert(difference(atFive, signature(rig.mesh)) < 1e-5, 'Seeking/looping/pausing must reuse the same pose');
  animation.sample(5);
  assert(difference(plain, signature(rig.mesh)) < 1e-5, 'Disabling physics must restore the animation');
  // Replay with a new Bullet world, not MMDPhysics.reset() (which leaves velocities/caches behind).
  const replay = createPhysicsSimulation(input);
  for (let n = 0; n < 60; n++) replay.step(0);
  for (let n = 1; n <= 300; n++) replay.step(n / 60);
  const replayCache = new PhysicsPoseCache(simulation.indices.length * 7);
  replayCache.put(300, 1, replay.capture()); animation.sample(5);
  assert(replayCache.apply(rig.mesh, replay.indices, 5));
  assert(difference(atFive, signature(rig.mesh)) < 1e-4, 'Recreated worker must deterministically replay');
  const limited = new PhysicsPoseCache(simulation.indices.length * 7, simulation.indices.length * 7 * 4 * 3);
  for (let n = 0; n < 20; n++) limited.put(n, 1, replay.capture());
  assert.equal(limited.capacity, 3);
  assert(!limited.has(0)); assert(!limited.has(16 / 60)); assert(limited.has(18 / 60));
  assert.equal(limited.apply(rig.mesh, simulation.indices, 0), false);
  limited.clear(); assert(!limited.has(18 / 60));
  console.log('PHYSICS_OK', path.basename(workerData.file), JSON.stringify({
    bodies: input.rig.mmd.rigidBodies.length, joints: input.rig.mmd.constraints.length,
    physicalBones: simulation.indices.length, hair: hair.length, skirt: skirt.length,
    maxBoneChange: difference(plain, atFive), totalMs: Math.round(performance.now() - start),
    heapMB: Ammo.HEAPU8.byteLength / 1024 ** 2,
  }));
  parentPort.postMessage('done');
}

if (!isMainThread) test().catch(error => { throw error; });
else (async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-physics-'));
  const output = path.join(temp, 'rig.cjs');
  try {
    require('esbuild').buildSync({ stdin: { contents: "export * from './src/motion-rig'; export * from './src/motion-physics-core';", resolveDir: root },
      outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['three', 'three-stdlib'] });
    const motion = JSON.parse(execFileSync(path.join(root, '.venv/bin/python'),
      ['-c', 'import sys,json;from motion_assets import read_vmd;print(json.dumps(read_vmd(sys.argv[1])))',
        path.join(root, '../datasets/motion/EX_HAPPY/motion.vmd')], { cwd: root, maxBuffer: 32 * 1024 ** 2 }));
    const source = path.join(root, '../datasets/character_model');
    const files = fs.readdirSync(source).filter(dir => fs.statSync(path.join(source, dir)).isDirectory())
      .flatMap(dir => fs.readdirSync(path.join(source, dir)).filter(file => file.endsWith('.pmx')).map(file => path.join(source, dir, file)));
    assert.equal(files.length, 3);
    for (const file of files) await new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { file, output, motion } });
      worker.once('error', reject);
      worker.once('message', () => worker.terminate().then(resolve));
    });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
