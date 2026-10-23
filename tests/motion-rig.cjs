// Run the shipped rig adapter against real PMX/VMD without a DOM or WebGL.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const THREE = require('three');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-rig-'));
const output = path.join(temp, 'rig.cjs');
require('esbuild').buildSync({ entryPoints: [path.join(root, 'src/motion-rig.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', external: ['three', 'three-stdlib'] });
// Module lookup for the temporary bundle must use this checkout's dependencies.
const Module = require('node:module');
const rigModule = new Module(output, module); rigModule.filename = output; rigModule.paths = module.paths;
rigModule._compile(fs.readFileSync(output, 'utf8'), output);
const { buildMotionMesh, animateMotion, mergeMotion } = rigModule.exports;
const readVmd = name => JSON.parse(execFileSync(path.join(root, '.venv/bin/python'),
  ['-c', 'import json,sys; from motion_assets import read_vmd; print(json.dumps(read_vmd(sys.argv[1])))',
    path.join(root, '../datasets/motion/EX_HAPPY', name)], { cwd: root, maxBuffer: 32 * 1024 ** 2 }));
const body = readVmd('motion.vmd'), facial = readVmd('facial.vmd'), cameraData = readVmd('camera.vmd');
const source = path.join(root, '../datasets/character_model');
const paths = fs.readdirSync(source).filter(dir => fs.statSync(path.join(source, dir)).isDirectory()).flatMap(dir => fs.readdirSync(path.join(source, dir))
  .filter(file => file.endsWith('.pmx')).map(file => path.join(source, dir, file)));
const signature = mesh => mesh.skeleton.bones.flatMap(b => [...b.position.toArray(), ...b.quaternion.toArray()]);
const vertexSignature = mesh => Array.from({ length: 40 }, (_, i) => {
  const index = Math.floor(i / 40 * mesh.geometry.attributes.position.count);
  return mesh.getVertexPosition(index, new THREE.Vector3()).toArray();
}).flat();
const difference = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
for (const file of paths) {
  const buffer = fs.readFileSync(file);
  const rig = buildMotionMesh(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const camera = new THREE.PerspectiveCamera();
  const motion = mergeMotion(body, facial);
  const animation = animateMotion(rig.mesh, rig.loader, motion, camera, cameraData);
  assert.equal(animation.missing.length, 0);
  animation.sample(0);
  const start = signature(rig.mesh), vertices = vertexSignature(rig.mesh), cameraStart = camera.position.toArray();
  animation.sample(5);
  const atFive = signature(rig.mesh), verticesFive = vertexSignature(rig.mesh);
  assert(difference(start, atFive) > .1, 'Bones must actually move');
  assert(difference(vertices, verticesFive) > .1, 'Skin must actually deform');
  assert(difference(cameraStart, camera.position.toArray()) > .1, 'Original camera must move');
  animation.sample(174 / 30);
  const key = cameraData.cameras.find(k => k.frameNum === 174);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...key.rotation.map(v => -v)));
  const cameraExpected = new THREE.Vector3(0, 0, -key.distance).applyQuaternion(q).add(new THREE.Vector3(...key.position));
  assert(cameraExpected.distanceTo(camera.position) < 1e-4, 'Tilted camera must orbit its target, not the world origin');
  for (const t of [12, 0, 16.666666, 4, 5, 5, 2, 5]) animation.sample(t);
  assert(difference(atFive, signature(rig.mesh)) < 1e-4, 'Seeking must not accumulate IK/grants');
  assert(difference(verticesFive, vertexSignature(rig.mesh)) < 1e-4);
  animation.sample(body.info.duration);
  assert(signature(rig.mesh).every(Number.isFinite));
  motion.switches = [{ frameNum: 0, visible: false, iks: [{ name: '左足ＩＫ', enabled: false }] }];
  animation.sample(0);
  assert.equal(rig.mesh.visible, false);
  const ik = rig.mesh.geometry.userData.MMD.iks.find(i => rig.mesh.skeleton.bones[i.target].name === '左足ＩＫ');
  assert(ik.links.every(l => l.enabled === false));
  animation.dispose(); rig.mesh.skeleton.dispose(); rig.mesh.geometry.dispose(); rig.materials.forEach(m => m.dispose());
  console.log('RIG_OK', path.basename(file), animation.matched.length, 'bones; deformation, seek stability, camera, IK switches');
}
fs.rmSync(temp, { recursive: true, force: true });
