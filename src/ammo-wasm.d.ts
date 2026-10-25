declare module 'ammojs3/dist/ammo.wasm.js' {
  const factory: (options: { wasmBinary: Uint8Array }) => Promise<unknown>;
  export default factory;
}
declare module '*?url' {
  const url: string;
  export default url;
}
