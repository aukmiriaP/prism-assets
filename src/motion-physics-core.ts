import * as THREE from 'three';
import { MMDPhysics } from 'three-stdlib';
import { animateMotion, createMotionLoader, type Vmd } from './motion-rig';
import { createHeadPoseStabilizer } from './motion-head-physics';
import { createGarmentPoseStabilizer } from './motion-garment-physics';

export const PHYSICS_FPS = 60;
export function physicsFrame(time: number): number {
  const frame = time * PHYSICS_FPS, nearest = Math.round(frame);
  // Exact timeline frames can acquire a tiny rounding error after division by FPS.
  return Math.abs(frame - nearest) < 1e-6 ? nearest : frame;
}
export type PhysicsRig = {
  bones: { name: string; parent: number; position: number[]; quaternion: number[]; scale: number[] }[];
  mmd: Record<string, unknown> & { rigidBodies: { boneIndex: number; type: number }[]; constraints: object[] };
};
export type PhysicsInput = { rig: PhysicsRig; motion: Vmd };
export type PhysicsRequest = { type: 'init'; input: PhysicsInput } | { type: 'target'; frame: number };
export type PhysicsResponse =
  | { type: 'frames'; start: number; count: number; poses: Float32Array }
  | { type: 'error'; message: string };

/** Capture before animation touches the rest pose. No geometry, textures or credentials cross threads. */
export function serializePhysicsRig(mesh: THREE.SkinnedMesh): PhysicsRig {
  const bones = mesh.skeleton.bones;
  return {
    bones: bones.map(b => ({ name: b.name, parent: bones.indexOf(b.parent as THREE.Bone),
      position: b.position.toArray(), quaternion: b.quaternion.toArray(), scale: b.scale.toArray() })),
    mmd: structuredClone(mesh.geometry.userData.MMD),
  };
}

export function physicsBoneIndices(rig: PhysicsRig): number[] {
  return [...new Set(rig.mmd.rigidBodies.filter(b => b.type !== 0 && b.boneIndex >= 0 && b.boneIndex < rig.bones.length)
    .map(b => b.boneIndex))].sort((a, b) => a - b);
}

/** This instance must live in a disposable worker: upstream MMDPhysics has no native destructor. */
export function createPhysicsSimulation(input: PhysicsInput) {
  const geometry = new THREE.BufferGeometry();
  geometry.userData.MMD = structuredClone(input.rig.mmd);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const bones = input.rig.bones.map(b => {
    const bone = new THREE.Bone(); bone.name = b.name;
    bone.position.fromArray(b.position); bone.quaternion.fromArray(b.quaternion); bone.scale.fromArray(b.scale);
    return bone;
  });
  input.rig.bones.forEach((b, i) => (b.parent < 0 ? mesh : bones[b.parent]).add(bones[i]));
  mesh.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(bones));
  const physics = new MMDPhysics(mesh, geometry.userData.MMD.rigidBodies, geometry.userData.MMD.constraints,
    { unitStep: 1 / PHYSICS_FPS, maxStepNum: 1 });
  const headPose = createHeadPoseStabilizer(physics, mesh, 1 / PHYSICS_FPS);
  const garmentPose = createGarmentPoseStabilizer(physics, mesh, 1 / PHYSICS_FPS);
  // Morph/camera evaluation stays on the visible rig. Only skeletal animation drives colliders.
  const animation = animateMotion(mesh, createMotionLoader(), { ...input.motion,
    morphs: [], cameras: [], metadata: { ...input.motion.metadata, morphCount: 0, cameraCount: 0 } });
  animation.sample(0); physics.reset();
  const indices = physicsBoneIndices(input.rig);
  const step = (time: number) => {
    animation.sample(time); physics.update(1 / PHYSICS_FPS);
    headPose.apply();
    garmentPose.apply();
  };
  const capture = () => {
    const values = new Float32Array(indices.length * 7);
    indices.forEach((index, i) => {
      bones[index].position.toArray(values, i * 7);
      bones[index].quaternion.toArray(values, i * 7 + 3);
    });
    if (!values.every(Number.isFinite)) throw new Error('模型物理产生了无效姿态');
    return values;
  };
  return { step, capture, indices };
}

/** Consecutive frame cache with a hard byte budget; old ranges can be replayed from rest. */
export class PhysicsPoseCache {
  private frames = new Map<number, Float32Array>();
  readonly capacity: number;
  constructor(readonly stride: number, byteBudget = 64 * 1024 ** 2) {
    this.capacity = Math.max(2, Math.floor(byteBudget / Math.max(4, stride * 4)));
  }
  put(start: number, count: number, poses: Float32Array) {
    for (let i = 0; i < count; i++) {
      this.frames.set(start + i, poses.slice(i * this.stride, (i + 1) * this.stride));
      while (this.frames.size > this.capacity) this.frames.delete(this.frames.keys().next().value!);
    }
  }
  has(time: number) {
    const frame = physicsFrame(time);
    return this.frames.has(Math.floor(frame)) && this.frames.has(Math.ceil(frame));
  }
  hasFrame(frame: number) { return this.frames.has(frame); }
  apply(mesh: THREE.SkinnedMesh, indices: number[], time: number) {
    const frame = physicsFrame(time), lo = Math.floor(frame), hi = Math.ceil(frame);
    const a = this.frames.get(lo), b = this.frames.get(hi);
    if (!a || !b) return false;
    const alpha = frame - lo;
    indices.forEach((index, i) => {
      const bone = mesh.skeleton.bones[index], offset = i * 7;
      bone.position.set(
        THREE.MathUtils.lerp(a[offset], b[offset], alpha),
        THREE.MathUtils.lerp(a[offset + 1], b[offset + 1], alpha),
        THREE.MathUtils.lerp(a[offset + 2], b[offset + 2], alpha));
      bone.quaternion.fromArray(a, offset + 3).slerp(boneQuaternion.fromArray(b, offset + 3), alpha);
    });
    mesh.updateMatrixWorld(true); mesh.skeleton.update();
    return true;
  }
  clear() { this.frames.clear(); }
}
const boneQuaternion = new THREE.Quaternion();
