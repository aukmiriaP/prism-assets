import * as THREE from 'three';
import type { MMDPhysics } from 'three-stdlib';

type NativeVector = { x(): number; y(): number; z(): number };
type NativeQuaternion = NativeVector & { w(): number };
type NativeTransform = { getOrigin(): NativeVector; getRotation(): NativeQuaternion };
type Body = {
  params: { boneIndex: number; type: number };
  bone: THREE.Bone;
  body: { getCenterOfMassTransform(): NativeTransform };
};
type Joint = {
  rigidBodyIndex1: number; rigidBodyIndex2: number;
  position: number[]; rotation: number[];
  translationLimitation1: number[]; translationLimitation2: number[];
  rotationLimitation1: number[]; rotationLimitation2: number[];
};
type PhysicsInternals = {
  bodies: Body[];
};

/**
 * Head chains contain tiny, often fully locked joints next to colliders. Bullet's
 * iterative solver can leave their errors visible as chatter. Project each
 * visible head chain back into its authored PMX joint limits, with a short temporal
 * filter on the permitted swing. Project only the displayed pose: forcing Bullet
 * bodies back into place injects impulses into coupled type-2 chains.
 * Clothing and the native world keep their original solver and collision data.
 */
export function createHeadPoseStabilizer(source: MMDPhysics, mesh: THREE.SkinnedMesh, stepSeconds: number) {
  const physics = source as unknown as PhysicsInternals, bones = mesh.skeleton.bones;
  const isHead = (bone: THREE.Object3D | null): boolean => {
    for (let current = bone; current; current = current.parent)
      if (/^(頭|头|head)(\d+)?$/i.test(current.name)) return true;
    return false;
  };
  const depth = (bone: THREE.Object3D) => {
    let value = 0;
    for (let current = bone.parent; current; current = current.parent) value++;
    return value;
  };
  const headBodies = new Set(physics.bodies.filter(b => b.params.type !== 0 && b.params.boneIndex >= 0 && isHead(b.bone)));
  const joints = mesh.geometry.userData.MMD.constraints as Joint[];
  const chosen = new Map<Body, Joint>();
  // Prefer the skeletal parent if several cross-links constrain the same body.
  for (const joint of joints) {
    const a = physics.bodies[joint.rigidBodyIndex1], b = physics.bodies[joint.rigidBodyIndex2];
    if (!headBodies.has(b) || !a || !isHead(a.bone)) continue;
    if (!chosen.has(b) || a.bone === b.bone.parent) chosen.set(b, joint);
  }
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(), unitScale = new THREE.Vector3(1, 1, 1);
  const read = (body: Body, matrix: THREE.Matrix4) => {
    const transform = body.body.getCenterOfMassTransform(), p = transform.getOrigin(), q = transform.getRotation();
    return matrix.compose(position.set(p.x(), p.y(), p.z()), rotation.set(q.x(), q.y(), q.z(), q.w()).normalize(), unitScale);
  };
  const rules = [...chosen].map(([body, joint]) => {
    const anchor = physics.bodies[joint.rigidBodyIndex1];
    const world = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(joint.position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...joint.rotation as [number, number, number])), unitScale);
    const frameB = read(body, new THREE.Matrix4()).invert().multiply(world);
    return { body, anchor, joint,
      frameA: read(anchor, new THREE.Matrix4()).invert().multiply(world),
      frameB, frameBInverse: frameB.clone().invert(),
      boneOffsetInverse: read(body, new THREE.Matrix4()).invert().multiply(body.bone.matrixWorld),
      previousPosition: new THREE.Vector3(), previousRotation: new THREE.Quaternion(),
      initialized: false, projected: new THREE.Matrix4(), applied: false };
  }).sort((a, b) => depth(a.body.bone) - depth(b.body.bone));
  const worldA = new THREE.Matrix4(), worldB = new THREE.Matrix4(), relative = new THREE.Matrix4();
  const target = new THREE.Matrix4(), euler = new THREE.Euler();
  const projectedBodies = new Map(rules.map(rule => [rule.body, rule]));
  const parentRotation = new THREE.Quaternion(), smoothedRotation = new THREE.Quaternion();
  const alpha = 1 - Math.exp(-stepSeconds / .04);
  const apply = () => {
    rules.forEach(rule => { rule.applied = false; });
    for (const rule of rules) {
      // Relative motion comes from the raw bodies. Compose it on the projected
      // parent afterwards so parent errors are not propagated down long chains.
      read(rule.anchor, worldA).multiply(rule.frameA);
      read(rule.body, worldB).multiply(rule.frameB);
      relative.copy(worldA).invert().multiply(worldB).decompose(position, rotation, scale);
      euler.setFromQuaternion(rotation, 'XYZ');
      for (let axis = 0; axis < 3; axis++) {
        const key = (['x', 'y', 'z'] as const)[axis];
        const j = rule.joint;
        // In Bullet, lower > upper denotes a free axis.
        if (j.translationLimitation1[axis] <= j.translationLimitation2[axis])
          position[key] = THREE.MathUtils.clamp(position[key], j.translationLimitation1[axis], j.translationLimitation2[axis]);
        if (j.rotationLimitation1[axis] <= j.rotationLimitation2[axis])
          euler[key] = THREE.MathUtils.clamp(euler[key], j.rotationLimitation1[axis], j.rotationLimitation2[axis]);
      }
      rotation.setFromEuler(euler);
      if (rule.initialized) {
        position.lerpVectors(rule.previousPosition, position, alpha);
        rotation.copy(smoothedRotation.copy(rule.previousRotation).slerp(rotation, alpha));
      }
      // Quaternion interpolation can leave an Euler box, so enforce its limits again.
      euler.setFromQuaternion(rotation, 'XYZ');
      for (let axis = 0; axis < 3; axis++) {
        const key = (['x', 'y', 'z'] as const)[axis], j = rule.joint;
        if (j.rotationLimitation1[axis] <= j.rotationLimitation2[axis])
          euler[key] = THREE.MathUtils.clamp(euler[key], j.rotationLimitation1[axis], j.rotationLimitation2[axis]);
      }
      rotation.setFromEuler(euler);
      rule.previousPosition.copy(position); rule.previousRotation.copy(rotation); rule.initialized = true;
      const parent = projectedBodies.get(rule.anchor);
      // Skeletal depths usually order joint chains; unusual cross-links may point
      // to a later rule. Use the raw anchor until it has been projected this step.
      if (parent?.applied) worldA.copy(parent.projected).multiply(rule.frameA);
      target.compose(position, rotation, unitScale).premultiply(worldA).multiply(rule.frameBInverse);
      rule.projected.copy(target);
      rule.applied = true;
      target.multiply(rule.boneOffsetInverse);
      target.decompose(position, rotation, scale);
      const bone = rule.body.bone;
      if (bone.parent) bone.parent.getWorldQuaternion(parentRotation).invert();
      else parentRotation.identity();
      bone.quaternion.copy(parentRotation.multiply(rotation)).normalize();
      if (rule.body.params.type === 1) {
        if (bone.parent) bone.parent.worldToLocal(position);
        bone.position.copy(position);
      }
      bone.updateMatrixWorld(true);
    }
  };
  return { apply, bones: [...headBodies].map(b => bones.indexOf(b.bone)), joints: rules.length };
}
