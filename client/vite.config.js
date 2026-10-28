import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Identificacao do build, exibida no painel de configuracoes.
// O deploy roda na Vercel, onde nao existe .git, entao o hash chega por
// VITE_BUILD_COMMIT (ver deploy-frontend.sh). Em build local caimos no git.
const resolveCommit = () => {
  if (process.env.VITE_BUILD_COMMIT) return process.env.VITE_BUILD_COMMIT.slice(0, 12)
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'n/d'
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(resolveCommit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          ui: ['lucide-react', 'react-hot-toast'],
          flow: ['reactflow']
        }
      }
    }
  },
  server: {
    // Allow Cloudflare quick tunnels (and similar reverse proxies) in local testing
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        configure: (proxy, _options) => {
          proxy.on('error', (err, _req, _res) => {
            console.log('❌ Proxy error:', err);
          });
          proxy.on('proxyReq', (proxyReq, req, _res) => {
            console.log('🔄 Proxy request:', req.method, req.url, '→', proxyReq.getHeader('host'));
          });
          proxy.on('proxyRes', (proxyRes, req, _res) => {
            console.log('✅ Proxy response:', req.method, req.url, '→', proxyRes.statusCode);
          });
        }
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        secure: false
      }
    },
    port: 3000,
    host: '0.0.0.0'
  }
})
