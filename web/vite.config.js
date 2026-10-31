import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000, target: 'es2022' },
});
