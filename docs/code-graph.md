# Code graph

Indexing builds a per-repository graph of definitions, imports and calls. Review retrieval, the agentic reviewer's `get_related_files` tool and context hints all use it.

## Languages

| Language | Parser | Import resolution |
| --- | --- | --- |
| TypeScript / JavaScript | TypeScript compiler | Relative modules (with extension inference) |
| Python | tree-sitter | Relative (`from .x import y`), absolute packages (root, `src/`, `lib/`, `app/`), submodules |
| Go | tree-sitter | Import path suffix → package directory |
| Java, Kotlin | tree-sitter | Fully qualified class → file; package / top-level function → package directory |
| Rust | tree-sitter | `crate::`, `super::`, `self::` → `x.rs` / `x/mod.rs` |
| Ruby | tree-sitter | `require_relative`, `require` (`lib/`, suffix match) |
| PHP | tree-sitter | PSR-4 style (`App\X\Y` → `app/X/Y.php`, `src/X/Y.php`) |
| C, C++ | tree-sitter | Quoted `#include` relative to the file, `include/`, suffix match |
| C#, Swift | tree-sitter | Definitions and calls; namespaces and modules are not file-resolvable |

Other files use a regex fallback for definitions and imports. The fallback also runs if a grammar cannot load, so indexing never fails because of the parser.

Calls resolve to repository files when the callee is defined in the same file, imported by name, or qualified by an imported module or class (`billing.Total()`, `Totals::total()`). Resolved edges carry `resolved: true` and the called symbol. Unresolved calls keep the raw callee text with `resolved: false` and are never traversed. Package targets end with `/` and expand to the files in that directory.

## Multi-hop traversal

`context.neighborhood` (`convex/context.ts`) walks resolved edges in both directions, so it finds callers as well as callees. It runs 1–3 hops (default 2) and ranks neighbours by edge weight and hop decay (`src/engine/graph.ts`). Reviews add the top 30 two-hop neighbours to their retrieved sources, and the agent's `get_related_files` tool returns the top 40. Every visited node costs a bounded number of index lookups.

## Runtime (WASM)

- Grammars come from `tree-sitter-wasms` (0.1.13) and run on `web-tree-sitter` (0.22.6), the newest runtime compatible with those grammar builds. Only the languages present in a batch are loaded.
- The loader sets `--no-wasm-tier-up --no-wasm-dynamic-tiering` before compiling grammars. Node 24's optimizing WebAssembly tier otherwise crashes the process with a Zone out-of-memory error on the large grammar modules; the baseline compiler is stable.
- `convex.json` marks both packages as `node.externalPackages`, so Convex installs them for Node actions instead of bundling them. They add about 50 MB to the deployment, well within Convex's 230 MB uncompressed limit.
- Verify a deployment with `npx convex run graphDiagnostics:status`. It loads every grammar and parses tiny fixtures only.

Changing extraction bumps `INDEX_GRAPH_VERSION` (`src/engine/index-version.ts`), which makes the next index job reparse unchanged files.
