import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'

const isDocker = fs.existsSync('/.dockerenv')
const backendTarget = isDocker ? 'http://backend:8000' : 'http://localhost:8000'
const rendererTarget = isDocker ? 'http://renderer:3100' : 'http://localhost:3100'
const clearcastTarget = isDocker ? 'http://clearcast:8770' : 'http://localhost:8770'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: [
      'openshorts.app',
      'www.openshorts.app',
      'klipra.ilmeaalim.com',
      'www.klipra.ilmeaalim.com',
      'klipra.app',
      'www.klipra.app',
      '.klipra.app',
      '.ilmeaalim.com'
    ],
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/videos': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/thumbnails': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/gallery': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/video': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/render': {
        target: rendererTarget,
        changeOrigin: true,
      },
      // Audio Cleaning engine (Clearcast) — a Docker service in this stack.
      // Reached by compose service name. Strip the /clearcast prefix.
      '/clearcast': {
        target: clearcastTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/clearcast/, ''),
      },
    }
  }
})

