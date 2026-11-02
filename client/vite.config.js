import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_API_PROXY || 'http://localhost:3000',
      '/auth': process.env.VITE_API_PROXY || 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
