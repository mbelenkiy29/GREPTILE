import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/**
 * Bundles the CLI with the app's engine, indexer, and model gateway (`@/lib/**`, resolved through the repository's
 * tsconfig paths) into `dist/cli.js`. npm dependencies stay external and are installed with the package; the
 * server's database migrations are copied next to the bundle for local mode.
 */
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  tsconfig: path.join(repoRoot, "tsconfig.json"),
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
  // The app's own modules are bundled; npm packages listed in package.json stay external.
  noExternal: [/^@\//],
  banner: { js: "#!/usr/bin/env node" },
  async onSuccess() {
    const target = path.join(here, "dist", "drizzle");
    await rm(target, { recursive: true, force: true });
    await cp(path.join(repoRoot, "drizzle"), target, { recursive: true });
  },
});
