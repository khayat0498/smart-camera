import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages deploy uchun
  base: process.env.NODE_ENV === 'production' ? '/smart-camera/' : '/',
  server: {
    port: 3000,
    open: true
  }
})