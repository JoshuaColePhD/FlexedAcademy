import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// PORT lets a launcher assign a free port; 5174 by default because 5173 is often
// already taken by another Vite project on this machine.
const port = Number(process.env.PORT) || 5174

/* Reloading a client-side route under /preview.html used to land on a dead
 * boot screen.
 *
 * preview.jsx installs the mock API and then lets React Router push routes
 * like /preview.html/onboarding. On a RELOAD of that URL, Vite looks for a
 * file at that path, doesn't find one, and falls back to index.html — the real
 * entry, with no mock installed. Every /api call then proxies to a backend
 * that usually isn't running, so the app sits on BootScreen forever with a
 * console full of 502s and no clue as to why.
 *
 * Rewriting to /preview.html keeps the mock entry serving its own deep links,
 * which is what makes the preview reloadable during a design pass. Dev-only,
 * like preview.html itself.
 */
const previewDeepLinks = {
  name: 'preview-html-deep-links',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/preview.html/')) {
        const [, query] = req.url.split('?')
        req.url = query ? `/preview.html?${query}` : '/preview.html'
      }
      next()
    })
  },
}

export default defineConfig({
  plugins: [react(), previewDeepLinks],
  build: {
    // Render's production build hit rolldown's default native "oxc" minifier
    // with an opaque, message-less binding crash (aggregateBindingErrorsIntoJsError,
    // no per-file detail) that a beefier local machine never reproduced —
    // esbuild's minifier is a separate, more battle-tested native pass, and
    // swapping to it is the cheapest way to tell a resource/native-binary
    // problem apart from a real source error.
    minify: 'esbuild',
    // Keep the large interaction libraries cacheable independently from the
    // route shell. A change to ChatPage should not invalidate React, motion,
    // or markdown for every teacher returning to the app.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('micromark')) {
            return 'vendor-markdown'
          }
          if (id.includes('framer-motion')) return 'vendor-motion'
          if (id.includes('react/') || id.includes('react-dom') || id.includes('scheduler')) {
            return 'vendor-react'
          }
          return undefined
        },
      },
    },
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
