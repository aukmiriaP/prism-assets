import type { SkinnedMesh } from 'three';
import { PhysicsPoseCache, physicsBoneIndices, physicsFrame, PHYSICS_FPS, type PhysicsInput, type PhysicsResponse } from './motion-physics-core';

export type PhysicsStatus = {
  phase: 'off' | 'unavailable' | 'buffering' | 'ready' | 'error';
  completed: number; target: number; error?: string;
};
export const idlePhysics = (phase: PhysicsStatus['phase']): PhysicsStatus => ({ phase, completed: 0, target: 0 });

export function createMotionPhysics(input: PhysicsInput, changed: (status: PhysicsStatus) => void) {
  const indices = physicsBoneIndices(input.rig), cache = new PhysicsPoseCache(indices.length * 7);
  const lastFrame = Math.ceil(physicsFrame(input.motion.info.duration));
  let worker: Worker | undefined, disposed = false, error = '', computed = -1, requested = -1, wanted = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let previousStatus = '';
  const notify = () => {
    const status: PhysicsStatus = { phase: error ? 'error' : cache.has(wanted) ? 'ready' : 'buffering',
      completed: Math.max(0, computed / PHYSICS_FPS), target: wanted, error: error || undefined };
    const signature = JSON.stringify(status);
    if (signature !== previousStatus && !disposed) { previousStatus = signature; changed(status); }
  };
  const stop = () => { worker?.terminate(); worker = undefined; clearTimeout(watchdog); };
  const fail = (message: string) => {
    stop(); error = message; cache.clear(); notify();
  };
  const guard = () => {
    clearTimeout(watchdog);
    if (computed < requested) watchdog = setTimeout(() => fail('物理计算超时，可关闭后重新开启'), 30000);
  };
  const start = () => {
    stop(); computed = -1; requested = -1; cache.clear();
    const current = new Worker(new URL('./motion-physics.worker.ts', import.meta.url), { type: 'module' });
    worker = current;
    current.onmessage = (event: MessageEvent<PhysicsResponse>) => {
      if (disposed || worker !== current) return;
      const message = event.data;
      if (message.type === 'error') { fail(message.message); return; }
      cache.put(message.start, message.count, message.poses);
      computed = message.start + message.count - 1;
      guard(); notify();
    };
    current.onerror = event => { if (worker === current && !disposed) { event.preventDefault(); fail('物理线程启动或执行失败'); } };
    current.onmessageerror = () => { if (worker === current && !disposed) fail('物理姿态传输失败'); };
    current.postMessage({ type: 'init', input });
  };
  const request = (time: number) => {
    wanted = Math.max(0, Math.min(input.motion.info.duration, time));
    if (disposed || error) return;
    try {
      const lo = Math.floor(physicsFrame(wanted));
      // A missing older frame was evicted: recreate the entire world, including velocities and solver state.
      if (!worker || (lo <= computed && !cache.hasFrame(lo))) start();
      const target = Math.min(lastFrame, Math.ceil(physicsFrame(wanted)) + 30);
      if (requested !== target) { requested = target; worker!.postMessage({ type: 'target', frame: target }); guard(); }
      notify();
    } catch (e) { fail(e instanceof Error ? e.message : String(e)); }
  };
  return {
    request,
    apply(mesh: SkinnedMesh, time: number) {
      request(time);
      // The caller already sampled the ordinary animation; errors fall back to that pose.
      return Boolean(error) || cache.apply(mesh, indices, wanted);
    },
    dispose() { disposed = true; stop(); cache.clear(); },
  };
}
