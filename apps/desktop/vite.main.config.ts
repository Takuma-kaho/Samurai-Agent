import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);

function isRuntimeExternal(id: string): boolean {
  return id === "electron" || id.startsWith("node:") || nodeBuiltins.has(id);
}

const desktopRuntimeUrlPlugin = {
  name: "desktop-runtime-url",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (!id.endsWith("/src/main.ts") && !id.endsWith("/src/config.ts")) return undefined;
    const transformed = code
      .replace(
        'new URL("./preload.cjs", import.meta.url)',
        'new URL(/* @vite-ignore */ "./preload.cjs", import.meta.url)'
      )
      .replace(
        'new URL("../../web/dist/index.html", import.meta.url)',
        'new URL(/* @vite-ignore */ "../../web/dist/index.html", import.meta.url)'
      );
    return transformed === code ? undefined : { code: transformed, map: null };
  }
};

export default defineConfig({
  plugins: [desktopRuntimeUrlPlugin],
  resolve: {
    conditions: ["node"]
  },
  build: {
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: "src/main.ts",
      external: isRuntimeExternal,
      output: {
        format: "es",
        entryFileNames: "main.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
