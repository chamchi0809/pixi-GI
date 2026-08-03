import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'pixi-rcgi',
    },
    rollupOptions: { external: ['pixi.js'] },
    sourcemap: true,
  },
});
