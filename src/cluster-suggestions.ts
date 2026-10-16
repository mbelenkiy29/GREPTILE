// Suggested repository clusters (cross-repository context). Deterministic: no model call. Signals come
// from each repository's indexed root manifests and its name:
// - package references: one repository depends on a package another repository publishes;
// - shared dependencies: two repositories share at least two dependencies few other repositories use;
// - naming: repository names share a distinctive word (acme/payments-api, acme/payments-web).
// Manifest content is untrusted repository text: only bounded, package-name-shaped strings are kept.
// Suggestions are proposals an admin approves; they are never applied automatically.

export const manifestPaths = ["package.json", "go.mod", "pyproject.toml", "requirements.txt", "Cargo.toml"] as const;
export type Manifest = { packages: string[]; dependencies: string[] };
export type RepositoryManifest = Manifest & { id: string; fullName: string };
export type ClusterReason = { kind: "imports" | "dependencies" | "naming"; detail: string };
export type ClusterSuggestion = { key: string; name: string; repositoryIds: string[]; reasons: ClusterReason[]; score: number };

const validName = (name: string) => name.length >= 1 && name.length <= 214 && /^[@\w][\w.\-/@~]*$/.test(name);
const clean = (names: string[]) => [...new Set(names.map((n) => n.trim().toLowerCase()).filter(validName))].slice(0, 500);
const tomlSection = (text: string, header: string) => {
  const start = text.search(new RegExp(`^\\[${header.replace(/[.[\]]/g, "\\$&")}\\]\\s*$`, "m"));
  if (start < 0) return "";
  const rest = text.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => /^\[/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
};
const tomlKeys = (section: string) => [...section.matchAll(/^\s*([A-Za-z0-9_.\-]+)\s*=/gm)].map((m) => m[1]);
// The body of `key = [ ... ]`, ending at the first `]` outside quotes (extras such as "pkg[fast]" stay inside).
const tomlArray = (section: string, key: string) => {
  const start = new RegExp(`^\\s*${key}\\s*=\\s*\\[`, "m").exec(section);
  if (!start) return "";
  let quote = "";
  for (let i = start.index + start[0].length; i < section.length; i++) {
    const c = section[i];
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "]") return section.slice(start.index + start[0].length, i);
  }
  return "";
};
const requirementName = (spec: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._\-]*)/.exec(spec.replace(/^["']/, ""))?.[1];

export function parseManifest(path: string, content: string): Manifest {
  const text = content.slice(0, 200_000).replace(/\r\n/g, "\n");
  const file = path.split("/").pop();
  try {
    if (file === "package.json") {
      const json = JSON.parse(text) as Record<string, unknown>;
      const keys = (field: string) => json[field] && typeof json[field] === "object" && !Array.isArray(json[field]) ? Object.keys(json[field] as object) : [];
      return { packages: clean(typeof json.name === "string" ? [json.name] : []), dependencies: clean(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(keys)) };
    }
    if (file === "go.mod") {
      const modulePath = /^module\s+(\S+)/m.exec(text)?.[1];
      const block = [...text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)].flatMap((m) => m[1].split("\n"));
      const single = [...text.matchAll(/^require\s+([^\s(]+)\s+\S+/gm)].map((m) => m[1]);
      return { packages: clean(modulePath ? [modulePath] : []), dependencies: clean([...single, ...block.map((l) => l.trim().split(/\s+/)[0]).filter((l) => l && !l.startsWith("//"))]) };
    }
    if (file === "pyproject.toml") {
      const project = tomlSection(text, "project"), poetry = tomlSection(text, "tool.poetry");
      const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(project || poetry)?.[1];
      const list = tomlArray(project, "dependencies");
      const listed = [...list.matchAll(/["']([^"']+)["']/g)].map((m) => requirementName(m[1])).filter((n): n is string => !!n);
      const poetryDeps = tomlKeys(tomlSection(text, "tool.poetry.dependencies")).filter((k) => k !== "python");
      return { packages: clean(name ? [name] : []), dependencies: clean([...listed, ...poetryDeps]) };
    }
    if (file === "requirements.txt")
      return { packages: [], dependencies: clean(text.split("\n").filter((l) => l.trim() && !/^\s*(#|-)/.test(l)).map((l) => requirementName(l)).filter((n): n is string => !!n)) };
    if (file === "Cargo.toml") {
      const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(tomlSection(text, "package"))?.[1];
      return { packages: clean(name ? [name] : []), dependencies: clean(["dependencies", "dev-dependencies", "build-dependencies"].flatMap((s) => tomlKeys(tomlSection(text, s)))) };
    }
  } catch { /* unreadable manifest: no signal */ }
  return { packages: [], dependencies: [] };
}
export function mergeManifests(manifests: Manifest[]): Manifest {
  return { packages: clean(manifests.flatMap((m) => m.packages)), dependencies: clean(manifests.flatMap((m) => m.dependencies)) };
}

// Words too generic to say two repositories belong together.
const genericWords = new Set("api web app apps service services server client ui frontend backend lib libs core sdk docs doc infra tools tool common shared test tests demo example examples main mobile site www cli worker workers config configs data db internal public private legacy new old v1 v2 v3 go js ts py rs java node python rust react next the and service-api".split(" "));
export const nameStems = (fullName: string) => [...new Set((fullName.split("/").pop() ?? "").toLowerCase().split(/[-_.]+/).filter((w) => w.length >= 3 && !genericWords.has(w) && !/^\d+$/.test(w)))];

export function suggestClusters(repos: RepositoryManifest[], options: { existing?: string[][]; skip?: Set<string>; limit?: number } = {}): ClusterSuggestion[] {
  const byId = new Map(repos.map((r) => [r.id, r]));
  const label = (id: string) => byId.get(id)!.fullName;
  const keyOf = (ids: string[]) => [...ids].sort().join(",");
  const candidates = new Map<string, ClusterSuggestion>();
  const add = (ids: string[], name: string, reason: ClusterReason, weight: number) => {
    const unique = [...new Set(ids)].sort();
    if (unique.length < 2 || unique.length > 20) return;
    const key = keyOf(unique);
    const held = candidates.get(key) ?? { key, name, repositoryIds: unique, reasons: [], score: 0 };
    if (!held.reasons.some((r) => r.detail === reason.detail)) { held.reasons.push(reason); held.score += weight; }
    candidates.set(key, held);
  };
  // Pairwise edges from package references and uncommon shared dependencies, grouped into components.
  const usage = new Map<string, number>();
  for (const r of repos) for (const d of r.dependencies) usage.set(d, (usage.get(d) ?? 0) + 1);
  const uncommon = (d: string) => (usage.get(d) ?? 0) <= Math.max(2, Math.floor(repos.length * 0.3));
  const publishers = new Map<string, string>();
  for (const r of repos) for (const p of r.packages) if (!publishers.has(p)) publishers.set(p, r.id);
  const edges: { a: string; b: string; reason: ClusterReason; weight: number }[] = [];
  for (const r of repos) for (const d of r.dependencies) {
    const publisher = publishers.get(d);
    if (publisher && publisher !== r.id) edges.push({ a: r.id, b: publisher, weight: 3, reason: { kind: "imports", detail: `${label(r.id)} depends on ${d}, published by ${label(publisher)}` } });
  }
  for (const [i, a] of repos.entries()) for (const b of repos.slice(i + 1)) {
    const own = new Set([...a.packages, ...b.packages]);
    const shared = a.dependencies.filter((d) => b.dependencies.includes(d) && uncommon(d) && !own.has(d));
    if (shared.length >= 2) edges.push({ a: a.id, b: b.id, weight: 1 + Math.min(shared.length, 5) / 5, reason: { kind: "dependencies", detail: `${label(a.id)} and ${label(b.id)} share uncommon dependencies: ${shared.slice(0, 5).join(", ")}` } });
  }
  const parent = new Map(repos.map((r) => [r.id, r.id]));
  const find = (x: string): string => { const p = parent.get(x)!; if (p === x) return x; const root = find(p); parent.set(x, root); return root; };
  for (const e of edges) parent.set(find(e.a), find(e.b));
  const components = new Map<string, string[]>();
  for (const r of repos) if (edges.some((e) => e.a === r.id || e.b === r.id)) { const root = find(r.id); components.set(root, [...(components.get(root) ?? []), r.id]); }
  for (const members of components.values()) {
    // Over 20 repositories: keep the best-connected 20.
    const degree = (id: string) => edges.filter((e) => e.a === id || e.b === id).reduce((n, e) => n + e.weight, 0);
    const kept = members.length > 20 ? [...members].sort((x, y) => degree(y) - degree(x)).slice(0, 20) : members;
    const inside = edges.filter((e) => kept.includes(e.a) && kept.includes(e.b));
    const shared = inside.find((e) => e.reason.kind === "imports");
    const name = shared ? `${label(shared.b).split("/").pop()} and dependents` : `${label(kept[0]).split("/").pop()} group`;
    for (const e of inside) add(kept, name, e.reason, e.weight);
  }
  // Naming: every distinctive word shared by at least two repositories.
  const stems = new Map<string, string[]>();
  for (const r of repos) for (const s of nameStems(r.fullName)) stems.set(s, [...(stems.get(s) ?? []), r.id]);
  for (const [stem, ids] of stems) if (ids.length >= 2) add(ids, stem, { kind: "naming", detail: `Names share "${stem}": ${ids.map(label).join(", ")}` }, 1);
  // Never re-propose a set that already is (or sits inside) a cluster, or one an admin decided on.
  const existing = (options.existing ?? []).map((ids) => new Set(ids));
  return [...candidates.values()]
    .filter((c) => !options.skip?.has(c.key) && !existing.some((set) => c.repositoryIds.every((id) => set.has(id))))
    .map((c) => ({ ...c, reasons: c.reasons.slice(0, 10), score: Math.round(c.score * 100) / 100 }))
    .sort((x, y) => y.score - x.score || x.key.localeCompare(y.key))
    .slice(0, options.limit ?? 10);
}
