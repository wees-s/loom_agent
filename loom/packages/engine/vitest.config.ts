import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tell Vite to treat node:sqlite as an external (it's a built-in that requires
  // --experimental-sqlite and must never be bundled by Vite/esbuild).
  optimizeDeps: {
    exclude: ["node:sqlite"],
  },
  build: {
    rollupOptions: {
      external: ["node:sqlite"],
    },
  },
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--experimental-sqlite"],
      },
    },
    // Exclude node: prefixed builtins from Vite transforms.
    server: {
      deps: {
        external: ["node:sqlite"],
      },
    },
  },
});
