import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// PORT lets a launcher assign a free port; 5174 by default because 5173 is often
// already taken by another Vite project on this machine.
const port = Number(process.env.PORT) || 5174

export default defineConfig({
  plugins: [react()],
  resolve: {
    /* onnxruntime-web (voice mode's Silero VAD) ships two flavours of each
       entry point, chosen by this resolve condition: a "bundle" variant with the
       wasm binary embedded, and a plain variant that fetches the binary at
       runtime from ort.env.wasm.wasmPaths. The bundle variant is the default,
       and it put 12.9MB of wasm into dist/assets on top of the identical copy
       already staged into public/vad/ by scripts/stage-vad-assets.mjs — shipped
       twice, loaded once, and unloadable from a code-split chunk.

       Naming the condition selects the external-wasm variant, so the binary is
       an asset served from a stable path and cached by the browser like any
       other. See src/lib/sileroVad.js, which also has to import the /wasm
       subpath rather than the default (WebGPU) one. */
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  optimizeDeps: {
    /* ORT reaches its emscripten glue module by dynamic import(). Vite's dep
       pre-bundler rewrites that import to a path inside node_modules/.vite/deps/
       but doesn't emit the glue there, so the fetch 404s and ORT reports the
       unhelpful "no available backend found". Excluding the package leaves the
       import resolving against node_modules as written, which works in dev and
       bundles normally for the build. */
    exclude: ['onnxruntime-web'],
  },
  server: {
    port,
    // Proxying /api makes the app same-origin in dev: no API host hardcoded
    // anywhere, and CORS stops mattering. VITE_API_URL overrides the base for a
    // deployed build. 8010 because 8000 is the local oMLX server.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8010',
        changeOrigin: true,
      },
    },
  },
})
