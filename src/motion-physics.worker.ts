import AmmoFactory from 'ammojs3/dist/ammo.wasm.js';
import wasmUrl from 'ammojs3/dist/ammo.wasm.wasm?url';
import { createPhysicsSimulation, PHYSICS_FPS, type PhysicsRequest, type PhysicsResponse } from './motion-physics-core';

const scope = globalThis as unknown as {
  Ammo: unknown;
  onmessage: (event: MessageEvent<PhysicsRequest>) => void;
  postMessage(message: PhysicsResponse, transfer?: Transferable[]): void;
};
let simulation: ReturnType<typeof createPhysicsSimulation> | undefined;
let target = 0, frame = -1, warming = PHYSICS_FPS, running = false, failed = false;
const fail = (error: unknown) => {
  failed = true;
  scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
};
function pump() {
  if (running || failed || !simulation) return;
  running = true;
  const tick = () => {
    try {
      const deadline = performance.now() + 24;
      while (warming > 0 && performance.now() < deadline) { simulation!.step(0); warming--; }
      if (!warming) {
        const start = frame + 1, poses: Float32Array[] = [];
        while (frame < target && performance.now() < deadline) {
          frame++;
          if (frame > 0) simulation!.step(frame / PHYSICS_FPS);
          poses.push(simulation!.capture());
        }
        if (poses.length) {
          const values = new Float32Array(poses.length * poses[0].length);
          poses.forEach((p, i) => values.set(p, i * p.length));
          scope.postMessage({ type: 'frames', start, count: poses.length, poses: values }, [values.buffer]);
        }
      }
      if (warming || frame < target) setTimeout(tick, 0);
      else running = false;
    } catch (error) { fail(error); }
  };
  setTimeout(tick, 0);
}
scope.onmessage = event => {
  const message = event.data;
  if (message.type === 'target') { target = message.frame; pump(); return; }
  (async () => {
    // Passing bytes avoids Emscripten's automatic URL/streaming fetch in packaged file:// workers.
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error('本地物理引擎读取失败');
    // The upstream factory assigns this.Ammo; ES-module workers run in strict mode.
    scope.Ammo = await AmmoFactory.call(scope, { wasmBinary: new Uint8Array(await response.arrayBuffer()) });
    simulation = createPhysicsSimulation(message.input);
    pump();
  })().catch(fail);
};
