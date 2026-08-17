/* Stages the Silero VAD model and the ONNX Runtime wasm binary into public/vad/.
 *
 * Both have to be fetched at runtime from our own origin, which means they have
 * to be real files on disk rather than bundle imports:
 *
 *   - ONNX Runtime resolves its wasm binary at runtime from a base path we hand
 *     it (ort.env.wasm.wasmPaths). It is not an ES import and a bundler cannot
 *     see it.
 *   - The .onnx model is loaded by URL for the same reason.
 *
 * public/ is the right home because Vite copies it verbatim into dist/, and the
 * backend serves dist/ (see backend/server.py's catch-all FileResponse). So
 * /vad/silero_vad_v5.onnx resolves identically in dev and in production without
 * either side knowing this script ran.
 *
 * Runs from predev/prebuild rather than being committed: these are 15MB of
 * vendored binaries whose version should follow package.json, not a stale copy
 * someone checked in once. public/vad/ is gitignored for the same reason.
 */
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dest = join(root, 'public', 'vad')

/* Only the plain wasm build, not the jsep (WebGPU) one — that's 26.8MB against
   12.9MB and buys nothing for a 309K-parameter model that runs in well under a
   millisecond on one CPU thread.

   Deliberately NOT ORT's ort-wasm-simd-threaded.mjs glue module, which lives
   beside the binary in node_modules and looks like it belongs here too. It
   doesn't: ORT loads the glue by dynamic import(), and Vite refuses to import
   anything under public/ — so staging it here worked in production and 500'd in
   dev. sileroVad.js points wasmPaths at the binary alone and lets the bundler
   resolve the glue from node_modules; see its own comment. */
const FILES = [
  ['@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'silero_vad_v5.onnx'],
  ['onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
]

mkdirSync(dest, { recursive: true })

let staged = 0
let skipped = 0
for (const [from, to] of FILES) {
  const src = join(root, 'node_modules', from)
  if (!existsSync(src)) {
    console.error(`[vad-assets] MISSING ${from} — run npm install`)
    process.exitCode = 1
    continue
  }
  const out = join(dest, to)
  // Skip an unchanged copy: this tree syncs via Google Drive, and rewriting
  // 15MB of identical bytes on every dev server start is not free.
  if (existsSync(out) && statSync(out).size === statSync(src).size) {
    skipped += 1
    continue
  }
  cpSync(src, out)
  staged += 1
}

console.log(
  `[vad-assets] ${staged} staged, ${skipped} already current → public/vad/`
)
