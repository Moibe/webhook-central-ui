import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],
  // En dev, /api va al servidor de auth (npm start)
  server: { proxy: { '/api': 'http://localhost:4174' } },
})
