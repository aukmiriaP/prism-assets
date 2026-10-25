/** Original procedural preview mannequin. No external model, textures or Blender required. */
import * as THREE from 'three';
import { createMotionLoader, type buildMotionMesh } from './motion-rig';

export const DEFAULT_MOTION_MODEL = 'builtin-prism-mannequin';
export const MOTION_MODEL_STORAGE = 'prism.motion-model.v1';
type Point = [number, number, number];
type Joint = { name: string; parent: number; position: THREE.Vector3 };
type Ik = { target: number; effector: number; iteration: number; maxAngle: number;
  links: { index: number; enabled: boolean; rotationMin?: THREE.Vector3; rotationMax?: THREE.Vector3 }[] };

export function buildDefaultMotionMesh(): ReturnType<typeof buildMotionMesh> {
  const joints: Joint[] = [], ids = new Map<string, number>(), iks: Ik[] = [];
  const materials = [
    new THREE.MeshStandardMaterial({ name: 'Porcelain shell', color: 0xd8dddf, roughness: .42, metalness: .08 }),
    new THREE.MeshStandardMaterial({ name: 'Graphite joints', color: 0x303740, roughness: .65 }),
    new THREE.MeshStandardMaterial({ name: 'Face plate', color: 0x515d69, roughness: .28, metalness: .25 }),
    new THREE.MeshStandardMaterial({ name: 'Eye markers', color: 0xd8e8e8, roughness: .45 }),
  ];
  const positions: number[] = [], normals: number[] = [], skinIndices: number[] = [], skinWeights: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];
  const addBone = (name: string, parent: string | null, point: Point) => {
    ids.set(name, joints.length);
    joints.push({ name, parent: parent === null ? -1 : ids.get(parent)!, position: new THREE.Vector3(...point) });
  };
  const point = (name: string) => joints[ids.get(name)!].position;
  const append = (source: THREE.BufferGeometry, joint: string, materialIndex: number,
    blend?: (position: THREE.Vector3) => [string, number]) => {
    const geometry = source.index ? source.toNonIndexed() : source;
    const pos = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    groups.push({ start: positions.length / 3, count: pos.count, materialIndex });
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      const [other, weight] = blend?.(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))) || [joint, 0];
      skinIndices.push(ids.get(joint)!, ids.get(other)!, 0, 0);
      skinWeights.push(1 - weight, weight, 0, 0);
    }
    if (geometry !== source) geometry.dispose();
    source.dispose();
  };
  const ellipsoid = (joint: string, center: THREE.Vector3, scale: Point, material = 0) => {
    const geometry = new THREE.SphereGeometry(1, 24, 16);
    geometry.scale(...scale); geometry.translate(...center.toArray());
    append(geometry, joint, material);
  };
  const segment = (joint: string, from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, material = 0) => {
    const length = from.distanceTo(to), axis = to.clone().sub(from).normalize();
    const shape = new THREE.LatheGeometry([
      new THREE.Vector2(0, .07 * length), new THREE.Vector2(r0 * .75, .08 * length),
      new THREE.Vector2(r0, .17 * length), new THREE.Vector2(r0 * .97, .3 * length),
      new THREE.Vector2(r1, .78 * length), new THREE.Vector2(r1 * .8, .91 * length),
      new THREE.Vector2(0, .94 * length),
    ], 24);
    shape.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis));
    shape.translate(...from.toArray()); append(shape, joint, material);
  };
  addBone('全ての親', null, [0, 0, 0]);
  addBone('センター', '全ての親', [0, 9.1, 0]);
  addBone('グルーブ', 'センター', [0, 9.1, 0]);
  addBone('腰', 'グルーブ', [0, 9.1, 0]);
  addBone('下半身', '腰', [0, 9.1, 0]);
  addBone('上半身', '腰', [0, 10.2, 0]);
  addBone('上半身2', '上半身', [0, 12.1, 0]);
  addBone('首', '上半身2', [0, 14.1, 0]);
  addBone('頭', '首', [0, 14.7, 0]);
  addBone('両目', '頭', [0, 16.1, .7]);
  addBone('左目', '両目', [.32, 16.1, .7]);
  addBone('右目', '両目', [-.32, 16.1, .7]);

  // A continuous torso blends between the two standard MMD spine joints.
  const torso = new THREE.LatheGeometry([
    new THREE.Vector2(0, 9.7), new THREE.Vector2(.83, 9.75), new THREE.Vector2(.87, 10.2),
    new THREE.Vector2(.92, 10.9), new THREE.Vector2(1.25, 12.2), new THREE.Vector2(1.55, 13.2),
    new THREE.Vector2(1.42, 13.75), new THREE.Vector2(.65, 14.05), new THREE.Vector2(0, 14.05),
  ], 40);
  torso.scale(1, 1, .63);
  append(torso, '上半身', 0, p => ['上半身2', THREE.MathUtils.smoothstep(p.y, 10.8, 12.8)]);
  ellipsoid('下半身', new THREE.Vector3(0, 9.25, 0), [1.3, .85, .73]);
  ellipsoid('首', new THREE.Vector3(0, 14.45, 0), [.4, .53, .4], 1);
  ellipsoid('頭', new THREE.Vector3(0, 16.0, 0), [.97, 1.31, .83]);
  ellipsoid('頭', new THREE.Vector3(0, 16.04, .68), [.79, .67, .27], 2);
  for (const side of ['左', '右']) {
    const sign = side === '左' ? 1 : -1;
    ellipsoid(side + '目', new THREE.Vector3(sign * .32, 16.12, .94), [.15, .07, .045], 3);
    addBone(side + '肩', '上半身2', [sign * .95, 13.7, 0]);
    addBone(side + '腕', side + '肩', [sign * 1.65, 13.55, 0]);
    addBone(side + '腕捩', side + '腕', [sign * 1.65, 13.55, 0]);
    addBone(side + 'ひじ', side + '腕捩', [sign * 3.95, 12.15, 0]);
    addBone(side + '手捩', side + 'ひじ', [sign * 3.95, 12.15, 0]);
    addBone(side + '手首', side + '手捩', [sign * 5.85, 10.98, 0]);
    ellipsoid(side + '腕', point(side + '腕'), [.56, .56, .56], 1);
    segment(side + '腕捩', point(side + '腕'), point(side + 'ひじ'), .51, .35);
    ellipsoid(side + 'ひじ', point(side + 'ひじ'), [.34, .34, .34], 1);
    segment(side + '手捩', point(side + 'ひじ'), point(side + '手首'), .38, .24);
    ellipsoid(side + '手首', point(side + '手首'), [.23, .23, .23], 1);
    const wrist = point(side + '手首'), forward = new THREE.Vector3(sign * .852, -.524, 0);
    const spread = new THREE.Vector3(sign * .524, .852, 0);
    const palmEnd = wrist.clone().addScaledVector(forward, .7);
    segment(side + '手首', wrist, palmEnd, .29, .32);
    const fingerNames = ['小指', '薬指', '中指', '人指', '親指'];
    fingerNames.forEach((finger, f) => {
      const thumb = f === 4;
      const start = wrist.clone().addScaledVector(forward, thumb ? .24 : .6).addScaledVector(spread, (f - 1.5) * .18);
      const direction = forward.clone().addScaledVector(spread, thumb ? .75 : (f - 1.5) * .06).normalize();
      const length = [.72, .93, 1, .87, .8][f];
      for (let j = 0; j < 3; j++) {
        const name = `${side}${finger}${'０１２３'[j + (thumb ? 0 : 1)]}`;
        const parent = j === 0 ? side + '手首' : `${side}${finger}${'０１２３'[j - 1 + (thumb ? 0 : 1)]}`;
        const origin = start.clone().addScaledVector(direction, j * length / 3);
        addBone(name, parent, origin.toArray() as Point);
        segment(name, origin, origin.clone().addScaledVector(direction, length / 3), .105, .083);
        if (j) ellipsoid(name, origin, [.095, .095, .095], 1);
      }
    });
    addBone(side + '足', '下半身', [sign * .95, 8.8, 0]);
    addBone(side + 'ひざ', side + '足', [sign * 1.02, 4.95, .15]);
    addBone(side + '足首', side + 'ひざ', [sign * 1.02, .95, 0]);
    addBone(side + 'つま先', side + '足首', [sign * 1.02, .3, 1.15]);
    addBone(side + '足IK親', '全ての親', [sign * 1.02, 0, 0]);
    addBone(side + '足ＩＫ', side + '足IK親', [sign * 1.02, .95, 0]);
    addBone(side + 'つま先ＩＫ', side + '足ＩＫ', [sign * 1.02, .3, 1.15]);
    ellipsoid(side + '足', point(side + '足'), [.56, .56, .56], 1);
    segment(side + '足', point(side + '足'), point(side + 'ひざ'), .64, .4);
    ellipsoid(side + 'ひざ', point(side + 'ひざ'), [.39, .39, .39], 1);
    segment(side + 'ひざ', point(side + 'ひざ'), point(side + '足首'), .44, .28);
    ellipsoid(side + '足首', point(side + '足首'), [.28, .28, .28], 1);
    ellipsoid(side + '足首', new THREE.Vector3(sign * 1.02, .43, .43), [.46, .42, .95]);
    iks.push({ target: ids.get(side + '足ＩＫ')!, effector: ids.get(side + '足首')!, iteration: 32, maxAngle: .5,
      links: [{ index: ids.get(side + 'ひざ')!, enabled: true, rotationMin: new THREE.Vector3(0, 0, 0),
        rotationMax: new THREE.Vector3(Math.PI - .01, 0, 0) }, { index: ids.get(side + '足')!, enabled: true }] });
    iks.push({ target: ids.get(side + 'つま先ＩＫ')!, effector: ids.get(side + 'つま先')!, iteration: 8, maxAngle: .5,
      links: [{ index: ids.get(side + '足首')!, enabled: true }] });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  groups.forEach(group => geometry.addGroup(group.start, group.count, group.materialIndex));
  geometry.userData.MMD = {
    format: 'pmx', iks, grants: [], rigidBodies: [], constraints: [],
    bones: joints.map((j, index) => ({ index, name: j.name, parent: j.parent, transformationClass: iks.some(ik => ik.target === index) ? 1 : 0,
      rigidBodyType: -1, ik: iks.find(ik => ik.target === index) })),
  };
  const mesh = new THREE.SkinnedMesh(geometry, materials);
  const bones = joints.map(j => {
    const bone = new THREE.Bone(); bone.name = j.name; bone.position.copy(j.position);
    if (j.parent >= 0) bone.position.sub(joints[j.parent].position);
    return bone;
  });
  bones.forEach((bone, i) => (joints[i].parent < 0 ? mesh : bones[joints[i].parent]).add(bone));
  mesh.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
  mesh.morphTargetDictionary = {}; mesh.morphTargetInfluences = [];
  mesh.frustumCulled = false; mesh.name = 'Prism preview mannequin';
  return { mesh, materials, loader: createMotionLoader(), data: { textures: [],
    materials: materials.map(m => ({ name: m.name, diffuse: [1, 1, 1, 1], textureIndex: -1, flag: 0 })) } };
}
