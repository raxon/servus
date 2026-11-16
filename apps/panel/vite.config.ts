import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: "switch-polyfill-css-url",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?", 1)[0]!.endsWith("/input-switch-polyfill.js")) return;
      // Let Vite fingerprint the polyfill's runtime stylesheet as a local asset.
      return code.replace("import.meta.resolve('./input-switch-polyfill.css')", "new URL('./input-switch-polyfill.css', import.meta.url).href + (import.meta.env.DEV ? '?direct' : '')");
    },
  }],
  optimizeDeps: { exclude: ["input-switch-polyfill"] },
  build: { outDir: "dist/web", emptyOutDir: false },
  server: {
    host: "127.0.0.1",
    port: 4181,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4180", ws: true } },
  },
});
