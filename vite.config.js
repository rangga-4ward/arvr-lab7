import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    allowedHosts: ['.ngrok-free.dev'],
    host: true,
    port: 5173
  }
})
