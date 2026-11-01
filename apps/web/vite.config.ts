import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || './',
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact'
  },
  server: {
    port: 4173,
    host: true,
    allowedHosts: true,
    cors: true
  },
  preview: {
    port: 4173,
    host: true,
    allowedHosts: true,
    cors: true
  }
});
