import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const edgeApiTarget = process.env.POS_API_PROXY ?? 'http://127.0.0.1:3001';

export default defineConfig({
  envDir: '../../',
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': edgeApiTarget,
      '/socket': { target: edgeApiTarget.replace(/^http/, 'ws'), ws: true },
    },
  },
});
