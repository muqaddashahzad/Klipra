import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
        target: 'http://backend:8000',
        changeOrigin: true,
      },
      '/videos': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
      '/thumbnails': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
      '/gallery': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
      '/video': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
      '/render': {
        target: 'http://renderer:3100',
        changeOrigin: true,
      },
      // Audio Cleaning engine (Clearcast) — a Docker service in this stack.
      // Reached by compose service name. Strip the /clearcast prefix.
      '/clearcast': {
        target: 'http://clearcast:8770',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/clearcast/, ''),
      },
    }
  }
})
