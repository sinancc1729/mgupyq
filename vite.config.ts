import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base` lets the same build work on a sub-path (e.g. GitHub Pages: /mgu-pyq-hub/).
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
