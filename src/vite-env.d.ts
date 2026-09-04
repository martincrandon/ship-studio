/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

declare module '*.wasm?url' {
  const url: string;
  export default url;
}
