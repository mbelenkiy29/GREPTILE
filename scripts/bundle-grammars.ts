import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supportedGrammars } from "../src/engine/treesitter";

// Copies the tree-sitter runtime and exactly the grammars OpenReview supports into one directory with a
// SHA-256 manifest, for images and offline installs: set OPENREVIEW_GRAMMARS_DIR to that directory
// (on the Convex backend, where indexing runs). Usage: pnpm tsx scripts/bundle-grammars.ts [target]
const target = path.resolve(process.argv[2] ?? "deploy/grammars");
const packageDir = (name: string) => path.dirname(fileURLToPath(import.meta.resolve(name + "/package.json")));
const sources: [string, string][] = [["tree-sitter.wasm", path.join(packageDir("web-tree-sitter"), "tree-sitter.wasm")], ...supportedGrammars().map((g): [string, string] => [`tree-sitter-${g}.wasm`, path.join(packageDir("tree-sitter-wasms"), "out", `tree-sitter-${g}.wasm`)])];
await mkdir(target, { recursive: true });
const files: Record<string, string> = {};
for (const [name, from] of sources) {
  await copyFile(from, path.join(target, name));
  files[name] = createHash("sha256").update(await readFile(from)).digest("hex");
}
const versions = Object.fromEntries(await Promise.all(["web-tree-sitter", "tree-sitter-wasms"].map(async (p) => [p, JSON.parse(await readFile(path.join(packageDir(p), "package.json"), "utf8")).version])));
await writeFile(path.join(target, "manifest.json"), JSON.stringify({ versions, files }, null, 2) + "\n");
console.log(`Bundled ${sources.length} files into ${target}`);
