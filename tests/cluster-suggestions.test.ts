import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeManifests, nameStems, parseManifest, suggestClusters, type RepositoryManifest } from "../src/cluster-suggestions";

test("manifests: package names and dependencies per ecosystem; untrusted junk is dropped", () => {
  assert.deepEqual(parseManifest("package.json", JSON.stringify({ name: "@acme/ui", dependencies: { react: "19", "@acme/tokens": "1" }, devDependencies: { vitest: "5" }, peerDependencies: { "$(rm -rf)": "1" } })), { packages: ["@acme/ui"], dependencies: ["react", "@acme/tokens", "vitest"] });
  assert.deepEqual(parseManifest("go.mod", "module github.com/acme/billing\n\ngo 1.22\n\nrequire github.com/acme/ledger v1.2.0\nrequire (\n\tgithub.com/stripe/stripe-go/v76 v76.0.0\n\t// comment\n\tgolang.org/x/sync v0.7.0\n)\n"), { packages: ["github.com/acme/billing"], dependencies: ["github.com/acme/ledger", "github.com/stripe/stripe-go/v76", "golang.org/x/sync"] });
  assert.deepEqual(parseManifest("pyproject.toml", '[project]\nname = "acme-models"\ndependencies = [\n  "pydantic>=2",\n  "acme-ledger[fast]==1.0",\n]\n\n[tool.ruff]\nline-length = 100\n'), { packages: ["acme-models"], dependencies: ["pydantic", "acme-ledger"] });
  assert.deepEqual(parseManifest("pyproject.toml", '[tool.poetry]\nname = "acme-jobs"\n\n[tool.poetry.dependencies]\npython = "^3.12"\ncelery = "^5"\n'), { packages: ["acme-jobs"], dependencies: ["celery"] });
  assert.deepEqual(parseManifest("requirements.txt", "# pinned\nrequests==2.32\n-r base.txt\nacme-ledger>=1\n\n"), { packages: [], dependencies: ["requests", "acme-ledger"] });
  assert.deepEqual(parseManifest("Cargo.toml", '[package]\nname = "acme-core"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n\n[dev-dependencies]\ninsta = "1"\n'), { packages: ["acme-core"], dependencies: ["serde", "tokio", "insta"] });
  assert.deepEqual(parseManifest("package.json", "{ not json"), { packages: [], dependencies: [] });
  assert.deepEqual(mergeManifests([{ packages: ["a"], dependencies: ["x"] }, { packages: ["A"], dependencies: ["x", "y"] }]), { packages: ["a"], dependencies: ["x", "y"] });
  assert.deepEqual(nameStems("acme/payments-api"), ["payments"]);
  assert.deepEqual(nameStems("acme/web"), []);
});

const repo = (id: string, fullName: string, packages: string[] = [], dependencies: string[] = []): RepositoryManifest => ({ id, fullName, packages, dependencies });
const fleet = [
  repo("ui", "acme/design-system", ["@acme/ui"], ["react", "typescript"]),
  repo("web", "acme/storefront", ["storefront"], ["react", "typescript", "@acme/ui"]),
  repo("admin", "acme/backoffice", ["backoffice"], ["react", "typescript", "@acme/ui"]),
  repo("pay-api", "acme/payments-api", [], ["express", "typescript", "stripe", "pino-noir", "ledger-math"]),
  repo("pay-worker", "acme/payments-worker", [], ["typescript", "stripe", "pino-noir", "ledger-math"]),
  repo("docs", "acme/docs", [], ["typescript", "react"]),
  repo("lonely", "acme/lonely-tool", [], ["typescript"]),
];

test("suggestions: package references, uncommon shared dependencies and name stems, each with reasons", () => {
  const out = suggestClusters(fleet);
  const byKey = Object.fromEntries(out.map((s) => [s.repositoryIds.join("+"), s]));
  // @acme/ui is published by design-system and used by two apps.
  const ui = byKey["admin+ui+web"];
  assert.equal(ui.name, "design-system and dependents");
  assert.deepEqual(ui.reasons.map((r) => r.kind), ["imports", "imports"]);
  assert.match(ui.reasons[0].detail, /depends on @acme\/ui, published by acme\/design-system/);
  // Payments share stripe/pino-noir/ledger-math (uncommon) and the "payments" stem; react/typescript are too common.
  const pay = byKey["pay-api+pay-worker"];
  assert.deepEqual(pay.reasons.map((r) => r.kind).sort(), ["dependencies", "naming"]);
  assert.match(pay.reasons.find((r) => r.kind === "dependencies")!.detail, /stripe, pino-noir, ledger-math/);
  assert.ok(pay.score > ui.score - 10);
  assert.equal(out.some((s) => s.repositoryIds.includes("lonely") || s.repositoryIds.includes("docs")), false, "common dependencies alone never cluster");
});

test("existing clusters, their subsets and decided suggestions are never proposed again", () => {
  const first = suggestClusters(fleet);
  assert.equal(first.length, 2);
  assert.deepEqual(suggestClusters(fleet, { existing: [["ui", "web", "admin", "docs"]] }).map((s) => s.key), ["pay-api,pay-worker"]);
  assert.deepEqual(suggestClusters(fleet, { skip: new Set(["pay-api,pay-worker"]) }).map((s) => s.key), ["admin,ui,web"]);
  assert.deepEqual(suggestClusters(fleet, { limit: 1 }).length, 1);
  // A very large component keeps its 20 best-connected repositories.
  const many = Array.from({ length: 25 }, (_, i) => repo("r" + i, `acme/svc${i}`, [], ["@acme/core"]));
  const big = suggestClusters([repo("core", "acme/core", ["@acme/core"]), ...many]);
  assert.equal(big[0].repositoryIds.length, 20);
  assert.ok(big[0].repositoryIds.includes("core"));
});
