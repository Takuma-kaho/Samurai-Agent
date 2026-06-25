import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import * as compiler from "vue/compiler-sfc";

const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [vue({ compiler })],
  server: {
    watch: {
      ignored: [
        "**/.pnpm-store/**",
        "**/.playwright-mcp/**",
        "**/workspace-data/**",
        "**/dist/**",
        "**/dist-ts/**",
        "**/coverage/**",
        "**/*.timestamp-*.mjs",
        "**/.vite-temp/**"
      ]
    },
    proxy: {
      "/api": apiTarget,
      "/socket.io": {
        target: apiTarget,
        ws: true
      }
    }
  }
});
