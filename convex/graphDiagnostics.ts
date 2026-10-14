"use node";
import { internalAction } from "./_generated/server";
import { grammarStatus, loadGrammars } from "../src/engine/treesitter";
import { indexRepository } from "../src/engine/indexer";

// Operator check that tree-sitter WASM grammars load inside this deployment's Node runtime:
// `npx convex run graphDiagnostics:status`. Parses tiny fixtures only; no repository data.
export const status = internalAction({
  args: {},
  handler: async () => {
    const samples = [
      { path: "probe/a.py", sha: "p", content: "from .b import f\ndef g():\n  return f()\n" },
      { path: "probe/b.py", sha: "p", content: "def f():\n  return 1\n" },
      { path: "probe/main.go", sha: "p", content: "package main\nfunc main() {}\n" },
      { path: "probe/A.java", sha: "p", content: "class A { void m() {} }\n" },
      { path: "probe/a.kt", sha: "p", content: "fun k() = 1\n" }, { path: "probe/a.rs", sha: "p", content: "fn r() {}\n" },
      { path: "probe/a.rb", sha: "p", content: "def r; end\n" }, { path: "probe/A.cs", sha: "p", content: "class A { void M() {} }\n" },
      { path: "probe/a.php", sha: "p", content: "<?php function p() {}\n" }, { path: "probe/a.c", sha: "p", content: "int c(void) { return 0; }\n" },
      { path: "probe/a.cpp", sha: "p", content: "int c() { return 0; }\n" }, { path: "probe/a.swift", sha: "p", content: "func s() {}\n" },
    ];
    await loadGrammars(samples.map((s) => s.path));
    const index = indexRepository(samples, samples.map((s) => s.path));
    return { ...grammarStatus(), symbols: index.symbols.length, resolvedEdges: index.relationships.filter((r) => r.resolved).length };
  },
});
