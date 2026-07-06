import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    testTimeout: 20000,
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "test/**/*.test.ts"]
  }
});
