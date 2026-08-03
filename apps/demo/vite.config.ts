import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { target: "es2022" },
  // Use the library source directly so `pnpm dev` hot-reloads library edits.
  resolve: {
    alias: {
      "pixi-radiance": new URL(
        "../../packages/pixi-radiance/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  server: { port: 8282 },
});
