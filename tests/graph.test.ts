import { test, before } from "node:test";
import assert from "node:assert/strict";
import { indexRepository } from "../src/engine/indexer";
import { loadGrammars, grammarStatus } from "../src/engine/treesitter";
import { rankNeighborhood, memoryNeighbors } from "../src/engine/graph";
import { memoryToolbox } from "../src/engine/agent";
import type { SourceFile } from "../src/engine/types";

const f = (path: string, content: string): SourceFile => ({ path, content, sha: "s" });
// Each fixture: files, expected symbols ("path:name"), expected resolved edges ("from -kind(symbol)-> to").
const fixtures: Record<string, { files: SourceFile[]; symbols: string[]; edges: string[] }> = {
  python: {
    files: [f("app/billing.py", "def total(c):\n    return c\n\nclass Ledger:\n    pass\n"), f("app/util.py", "def fmt(x):\n    return x\n"), f("app/cart.py", "from .billing import total\nimport app.util as u\n\nclass Cart:\n    def amount(self):\n        return total(1) + u.fmt(2) + self.helper()\n\n    def helper(self):\n        return 0\n")],
    symbols: ["app/billing.py:total", "app/billing.py:Ledger", "app/cart.py:Cart", "app/cart.py:amount", "app/cart.py:helper"],
    edges: ["app/cart.py -imports(total)-> app/billing.py", "app/cart.py -imports(u)-> app/util.py", "app/cart.py -calls(total)-> app/billing.py", "app/cart.py -calls(fmt)-> app/util.py"],
  },
  go: {
    files: [f("internal/billing/total.go", "package billing\n\nfunc Total(c int) int { return c }\n"), f("cmd/pay/main.go", 'package main\n\nimport billing "github.com/acme/app/internal/billing"\n\ntype Gateway struct{}\n\nfunc (g Gateway) Charge(c int) int { return billing.Total(c) }\n\nfunc main() {}\n')],
    symbols: ["internal/billing/total.go:Total", "cmd/pay/main.go:Gateway", "cmd/pay/main.go:Charge", "cmd/pay/main.go:main"],
    edges: ["cmd/pay/main.go -imports(billing)-> internal/billing/", "cmd/pay/main.go -calls(Total)-> internal/billing/"],
  },
  java: {
    files: [f("src/main/java/com/acme/billing/Totals.java", "package com.acme.billing;\npublic class Totals { public static int total(int c) { return c; } }\n"), f("src/main/java/com/acme/pay/Gateway.java", "package com.acme.pay;\nimport com.acme.billing.Totals;\npublic class Gateway {\n  int charge(int c) { return Totals.total(c) + helper(c); }\n  int helper(int c) { return c; }\n}\n")],
    symbols: ["src/main/java/com/acme/billing/Totals.java:Totals", "src/main/java/com/acme/billing/Totals.java:total", "src/main/java/com/acme/pay/Gateway.java:charge"],
    edges: ["src/main/java/com/acme/pay/Gateway.java -imports(Totals)-> src/main/java/com/acme/billing/Totals.java", "src/main/java/com/acme/pay/Gateway.java -calls(total)-> src/main/java/com/acme/billing/Totals.java"],
  },
  kotlin: {
    files: [f("src/main/kotlin/com/acme/billing/Totals.kt", "package com.acme.billing\nfun total(c: Int) = c\nobject Fees\n"), f("src/main/kotlin/com/acme/pay/Gateway.kt", "package com.acme.pay\nimport com.acme.billing.total\nclass Gateway {\n  fun charge(c: Int): Int = total(c)\n}\n")],
    symbols: ["src/main/kotlin/com/acme/billing/Totals.kt:total", "src/main/kotlin/com/acme/billing/Totals.kt:Fees", "src/main/kotlin/com/acme/pay/Gateway.kt:Gateway", "src/main/kotlin/com/acme/pay/Gateway.kt:charge"],
    // Kotlin top-level functions belong to a package, not a file: the edge targets the package directory.
    edges: ["src/main/kotlin/com/acme/pay/Gateway.kt -imports(total)-> src/main/kotlin/com/acme/billing/", "src/main/kotlin/com/acme/pay/Gateway.kt -calls(total)-> src/main/kotlin/com/acme/billing/"],
  },
  rust: {
    files: [f("src/billing.rs", "pub fn total(c: i64) -> i64 { c }\n"), f("src/pay/mod.rs", "use super::billing::total;\npub struct Gateway;\nimpl Gateway { pub fn charge(&self, c: i64) -> i64 { total(c) } }\n"), f("src/lib.rs", "mod billing;\nmod pay;\npub fn run() -> i64 { crate::billing::total(1) }\n")],
    symbols: ["src/billing.rs:total", "src/pay/mod.rs:Gateway", "src/pay/mod.rs:charge", "src/lib.rs:run"],
    edges: ["src/pay/mod.rs -imports(total)-> src/billing.rs", "src/pay/mod.rs -calls(total)-> src/billing.rs", "src/lib.rs -calls(total)-> src/billing.rs"],
  },
  ruby: {
    files: [f("lib/billing.rb", "module Billing\n  def self.total(c)\n    c\n  end\nend\n"), f("lib/gateway.rb", "require_relative 'billing'\nclass Gateway\n  def charge(c)\n    Billing.total(c) + helper(c)\n  end\n  def helper(c)\n    c\n  end\nend\n")],
    symbols: ["lib/billing.rb:Billing", "lib/billing.rb:total", "lib/gateway.rb:Gateway", "lib/gateway.rb:charge", "lib/gateway.rb:helper"],
    edges: ["lib/gateway.rb -imports-> lib/billing.rb"],
  },
  c_sharp: {
    files: [f("src/Billing/Totals.cs", "namespace Acme.Billing {\n  public class Totals { public static int Total(int c) { return c; } }\n}\n"), f("src/Pay/Gateway.cs", "using Acme.Billing;\nnamespace Acme.Pay {\n  public class Gateway {\n    public int Charge(int c) { return Totals.Total(c) + Helper(c); }\n    int Helper(int c) => c;\n  }\n}\n")],
    symbols: ["src/Billing/Totals.cs:Totals", "src/Billing/Totals.cs:Total", "src/Pay/Gateway.cs:Gateway", "src/Pay/Gateway.cs:Charge", "src/Pay/Gateway.cs:Helper"],
    edges: [],
  },
  php: {
    files: [f("app/Billing/Totals.php", "<?php\nnamespace App\\Billing;\nclass Totals { public static function total($c) { return $c; } }\n"), f("app/Pay/Gateway.php", "<?php\nnamespace App\\Pay;\nuse App\\Billing\\Totals;\nclass Gateway {\n  public function charge($c) { return Totals::total($c) + $this->helper($c); }\n  private function helper($c) { return $c; }\n}\n")],
    symbols: ["app/Billing/Totals.php:Totals", "app/Billing/Totals.php:total", "app/Pay/Gateway.php:Gateway", "app/Pay/Gateway.php:charge", "app/Pay/Gateway.php:helper"],
    edges: ["app/Pay/Gateway.php -imports(Totals)-> app/Billing/Totals.php", "app/Pay/Gateway.php -calls(total)-> app/Billing/Totals.php"],
  },
  c: {
    files: [f("src/billing.h", "int total(int c);\n"), f("src/billing.c", '#include "billing.h"\nint total(int c) { return c; }\n'), f("src/pay.c", '#include "billing.h"\n#include <stdio.h>\nstruct gateway { int x; };\nint charge(int c) { return total(c); }\nstatic int helper(int c) { return c; }\n')],
    symbols: ["src/billing.c:total", "src/pay.c:gateway", "src/pay.c:charge", "src/pay.c:helper"],
    edges: ["src/pay.c -imports-> src/billing.h", "src/billing.c -imports-> src/billing.h"],
  },
  cpp: {
    files: [f("include/billing/totals.hpp", "namespace billing { int total(int c); }\n"), f("src/gateway.cpp", '#include "billing/totals.hpp"\nnamespace pay {\nclass Gateway { public: int charge(int c); };\nint Gateway::charge(int c) { return billing::total(c); }\n}\n')],
    symbols: ["src/gateway.cpp:Gateway", "src/gateway.cpp:charge"],
    edges: ["src/gateway.cpp -imports-> include/billing/totals.hpp"],
  },
  elixir: {
    files: [
      f("lib/my_app/repo.ex", "defmodule MyApp.Repo do\n  def get(schema, id), do: {schema, id}\nend\n"),
      f("lib/my_app/accounts/user.ex", "defmodule MyApp.Accounts.User do\n  defstruct [:id]\n  def changeset(user, attrs), do: Map.merge(user, attrs)\nend\n"),
      f("lib/my_app/accounts.ex", "defmodule MyApp.Accounts do\n  alias MyApp.Repo\n  alias MyApp.Accounts.User\n\n  def get_user(id), do: Repo.get(User, id)\n\n  def create(attrs) do\n    User.changeset(%User{}, attrs) |> helper()\n  end\n\n  defp helper(x) when is_map(x), do: x\nend\n"),
    ],
    symbols: ["lib/my_app/repo.ex:Repo", "lib/my_app/repo.ex:get", "lib/my_app/accounts/user.ex:User", "lib/my_app/accounts/user.ex:changeset", "lib/my_app/accounts.ex:Accounts", "lib/my_app/accounts.ex:get_user", "lib/my_app/accounts.ex:create", "lib/my_app/accounts.ex:helper"],
    edges: ["lib/my_app/accounts.ex -imports(Repo)-> lib/my_app/repo.ex", "lib/my_app/accounts.ex -imports(User)-> lib/my_app/accounts/user.ex", "lib/my_app/accounts.ex -calls(get)-> lib/my_app/repo.ex", "lib/my_app/accounts.ex -calls(changeset)-> lib/my_app/accounts/user.ex"],
  },
  swift: {
    files: [f("Sources/Billing/Totals.swift", "public func total(_ c: Int) -> Int { c }\n"), f("Sources/Pay/Gateway.swift", "import Billing\nstruct Gateway {\n  func charge(_ c: Int) -> Int { return helper(c) }\n  func helper(_ c: Int) -> Int { c }\n}\nprotocol Payable {}\n")],
    symbols: ["Sources/Billing/Totals.swift:total", "Sources/Pay/Gateway.swift:Gateway", "Sources/Pay/Gateway.swift:charge", "Sources/Pay/Gateway.swift:helper", "Sources/Pay/Gateway.swift:Payable"],
    edges: [],
  },
};

before(async () => { await loadGrammars(Object.values(fixtures).flatMap((x) => x.files.map((file) => file.path))); });

test("tree-sitter grammars load for every supported non-TS language", () => {
  // J8 added Elixir (same pinned tree-sitter-wasms build).
  assert.deepEqual(grammarStatus().loaded, ["c", "c_sharp", "cpp", "elixir", "go", "java", "kotlin", "php", "python", "ruby", "rust", "swift"]);
  assert.deepEqual(grammarStatus().failed, {});
});

for (const [language, fixture] of Object.entries(fixtures))
  test(`${language}: definitions and resolved import/call edges`, () => {
    const index = indexRepository(fixture.files, fixture.files.map((file) => file.path));
    const symbols = index.symbols.map((s) => `${s.path}:${s.name}`);
    for (const s of fixture.symbols) assert.ok(symbols.includes(s), `${language} missing symbol ${s}; got ${symbols.join(", ")}`);
    const edges = index.relationships.filter((r) => r.resolved).map((r) => `${r.from} -${r.kind}${r.symbol ? `(${r.symbol})` : ""}-> ${r.to}`);
    for (const e of fixture.edges) assert.ok(edges.includes(e), `${language} missing edge ${e}; got ${edges.join(" | ")}`);
    assert.ok(index.relationships.every((r) => r.to !== r.from), "no self edges");
  });

test("visibility heuristics mark exported definitions per language", () => {
  const index = indexRepository([...fixtures.go.files, ...fixtures.c.files, ...fixtures.php.files, ...fixtures.rust.files], []);
  const exported = (path: string, name: string) => index.symbols.find((s) => s.path === path && s.name === name)?.exported;
  assert.equal(exported("internal/billing/total.go", "Total"), true);
  assert.equal(exported("cmd/pay/main.go", "main"), false);
  assert.equal(exported("src/pay.c", "helper"), false);
  assert.equal(exported("src/pay.c", "charge"), true);
  assert.equal(exported("app/Pay/Gateway.php", "helper"), false);
  assert.equal(exported("src/billing.rs", "total"), true);
});

test("import resolution handles relative modules, submodules, crate paths, PSR-4 and include roots", () => {
  const files = [
    f("pkg/__init__.py", ""), f("pkg/models/__init__.py", ""), f("pkg/models/user.py", "class User:\n  pass\n"), f("pkg/views.py", "from .models import user\nfrom ..outside import nope\nfrom pkg.models.user import User\n"),
    f("src/a/mod.rs", "pub fn a() {}\n"), f("src/lib.rs", "use crate::a::a;\n"),
    f("vendor/acme/Util.php", "<?php class Util {}\n"), f("src/Http/Controller.php", "<?php\nuse Acme\\Http\\Missing;\nuse App\\Http\\Kernel;\n"), f("src/Http/Kernel.php", "<?php class Kernel {}\n"),
  ];
  const index = indexRepository(files, files.map((x) => x.path));
  const resolved = (from: string) => index.relationships.filter((r) => r.from === from && r.kind === "imports").map((r) => `${r.resolved ? "✓" : "✗"} ${r.to}`);
  assert.deepEqual(resolved("pkg/views.py").sort(), ["✓ pkg/models/user.py", "✓ pkg/models/user.py", "✗ ..outside"].sort());
  assert.deepEqual(resolved("src/lib.rs"), ["✓ src/a/mod.rs"]);
  assert.deepEqual(resolved("src/Http/Controller.php").sort(), ["✓ src/Http/Kernel.php", "✗ Acme\\Http\\Missing"].sort());
});

test("unsupported languages keep the regex fallback", () => {
  const index = indexRepository([f("build.zig", "fn main() void {}\nfn helper() void {}\n")], []);
  assert.deepEqual(index.symbols.map((s) => s.name), ["main", "helper"]);
});

test("TypeScript call edges resolve through named, default and namespace imports", () => {
  const files = [f("src/billing.ts", "export function total(c: number) { return c; }\nexport default function fee() { return 1; }"), f("src/cart.ts", "import fee, { total } from './billing';\nimport * as billing from './billing';\nexport const amount = () => total(1) + fee() + billing.total(2) + external();\nfunction local() { return amount(); }")];
  const index = indexRepository(files, files.map((x) => x.path));
  const calls = index.relationships.filter((r) => r.kind === "calls" && r.from === "src/cart.ts");
  assert.deepEqual(calls.filter((r) => r.resolved).map((r) => r.symbol).sort(), ["fee", "total", "total"]);
  assert.ok(calls.some((r) => r.resolved === false && r.to === "external"));
  assert.ok(!calls.some((r) => r.to === "src/cart.ts"), "same-file calls are not stored as self edges");
});

test("multi-hop traversal ranks direct callers above distant neighbours and stays within its hop bound", async () => {
  const edges = [
    { from: "src/cart.ts", to: "src/billing.ts", kind: "calls", resolved: true },
    { from: "src/payments.ts", to: "src/cart.ts", kind: "calls", resolved: true },
    { from: "src/api.ts", to: "src/payments.ts", kind: "calls", resolved: true },
    { from: "src/edge.ts", to: "src/api.ts", kind: "calls", resolved: true },
    { from: "tests/billing.test.ts", to: "src/billing.ts", kind: "imports" },
    { from: "src/cart.ts", to: "raw callee text", kind: "calls" },
    { from: "cmd/main.go", to: "internal/pay/", kind: "imports", resolved: true },
  ];
  const paths = ["src/billing.ts", "src/cart.ts", "src/payments.ts", "src/api.ts", "src/edge.ts", "tests/billing.test.ts", "cmd/main.go", "internal/pay/a.go", "internal/pay/b.go", "internal/pay/sub/c.go"];
  const neighbors = memoryNeighbors(edges, paths);
  const two = await rankNeighborhood(["src/billing.ts"], neighbors, { hops: 2 });
  assert.deepEqual(two.map((n) => [n.path, n.hops]), [["src/cart.ts", 1], ["tests/billing.test.ts", 1], ["src/payments.ts", 2]]);
  assert.equal(two[0].via, "calls (incoming)");
  const three = await rankNeighborhood(["src/billing.ts"], neighbors, { hops: 3 });
  assert.ok(three.some((n) => n.path === "src/api.ts" && n.hops === 3));
  assert.ok(!three.some((n) => n.path === "src/edge.ts"), "the fourth hop is out of bounds");
  assert.ok(!three.some((n) => n.path === "raw callee text"), "unresolved edges are not traversed");
  const pkg = await rankNeighborhood(["cmd/main.go"], neighbors, { hops: 1 });
  assert.deepEqual(pkg.map((n) => n.path).sort(), ["internal/pay/a.go", "internal/pay/b.go"]);
  const importers = await rankNeighborhood(["internal/pay/a.go"], neighbors, { hops: 1 });
  assert.deepEqual(importers.map((n) => n.path), ["cmd/main.go"]);
});

test("agent related-files tool returns ranked multi-hop neighbours", async () => {
  const files = [f("src/billing.ts", "export function total(c: number) { return c; }"), f("src/cart.ts", "import { total } from './billing';\nexport function checkout(c: number) { return total(c); }"), f("src/payments.ts", "import { checkout } from './cart';\nexport function charge(c: number) { return checkout(c); }")];
  const related = await memoryToolbox(files, "h").relatedFiles("src/billing.ts");
  assert.deepEqual(related.map((r) => r.path), ["src/cart.ts", "src/payments.ts"]);
  assert.match(related[1].reason, /2 hops/);
});
