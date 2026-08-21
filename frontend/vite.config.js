import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// PORT lets a launcher assign a free port; 5174 by default because 5173 is often
// already taken by another Vite project on this machine.
const port = Number(process.env.PORT) || 5174

export default defineConfig({
  plugins: [react()],
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
