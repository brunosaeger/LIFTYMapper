import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Em dev, o Vite roda na 5173 e o server.py (proxy pro robô + persistência
    // de pontos) na 8000. Encaminha /api pra lá em vez de duplicar essa lógica
    // no Vite. Em produção, server.py serve o build direto (mesma origem).
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
