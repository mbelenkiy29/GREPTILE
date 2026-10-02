import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.{ts,tsx}", "lib/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // PGlite boots and migrates a WASM Postgres per worker; the first test in a file pays for it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
