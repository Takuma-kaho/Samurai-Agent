import { builtinModules } from "node:module";
import { defineConfig, transformWithEsbuild } from "vite";

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);

function isRuntimeExternal(id: string): boolean {
  return id === "electron" || id.startsWith("node:") || nodeBuiltins.has(id);
}

const preloadTypeScriptPlugin = {
  name: "desktop-preload-typescript",
  enforce: "pre" as const,
  async transform(code: string, id: string) {
    if (!id.endsWith(".cts")) return undefined;
    // .cts makes esbuild force CommonJS before Rollup can see the local imports.
    // Use a temporary .ts identity for parsing; the final Rollup output remains CJS.
    return transformWithEsbuild(code, id.replace(/\.cts$/, ".ts"), {
      loader: "ts",
      target: "node20",
      format: "esm",
      sourcemap: true
    });
  }
};

export default defineConfig({
  plugins: [preloadTypeScriptPlugin],
  resolve: {
    conditions: ["node"]
  },
  build: {
    target: "node20",
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: "src/preload.cts",
      external: isRuntimeExternal,
      output: {
        format: "cjs",
        entryFileNames: "preload.cjs",
        chunkFileNames: "chunks/[name]-[hash].cjs",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  }
});
