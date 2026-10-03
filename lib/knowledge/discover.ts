/**
 * Subsystem discovery (R6.12): a deterministic pass over the index that groups a repository's files into at most
 * {@link MAX_SUBSYSTEMS} candidate subsystems, each with its files ranked by centrality (importers + callers), routes,
 * tables, tests, CI jobs, and dependencies. No model is involved; the same index always yields the same subsystems,
 * so entry slugs are stable across refreshes.
 *
 * Signals, strongest first:
 * - keywords in path components and file names (auth, session, billing, stripe, queue, worker, migration, docker, ...)
 * - file tags from the indexer (route, schema, migration, test, ci, config, instructions)
 * - symbol kinds and names (route, table, model, ci_job; exported names carrying keywords)
 * - the import graph: files without a keyword signal join the subsystem they import from or are imported by most,
 *   and directories with several such files become their own subsystem ("dense directories")
 * - `tested_by` edges attach test files to the subsystem of the code they test
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { edges, files, repoDependencies, symbols, type KnowledgeDependencies, type KnowledgeKind } from "@/lib/db/schema";
import type { RepoScope } from "@/lib/indexer/query";

export const MAX_SUBSYSTEMS = 12;
/** Files stored per entry (`relatedFiles`). */
export const MAX_RELATED_FILES = 50;
const MAX_FACTS = 20;
/** Files a repository may have before discovery looks only at the most central ones. */
const MAX_FILES = 20_000;
const MAX_EDGES = 200_000;

export interface DiscoveryFile {
  id: number;
  path: string;
  tags: string[];
  contentHash: string;
}

export interface DiscoveryInput {
  files: DiscoveryFile[];
  /** Resolved file → file imports. */
  imports: { from: number; to: number }[];
  /** Callers per file (call edges into the file's symbols). */
  callers: Map<number, number>;
  /** Source file → test file. */
  testedBy: { source: number; test: number }[];
  /** Symbols that carry signals: routes, tables/models, CI jobs, and exported names. */
  symbols: { fileId: number; name: string; kind: string; exported: boolean }[];
  /** Unresolved (package) imports per file. */
  externalImports: { fileId: number; target: string }[];
  /** Declared dependencies (manifests), for versions and to tell packages from unresolved local imports. */
  declared: { name: string; versionSpec: string | null }[];
}

export interface Subsystem {
  slug: string;
  title: string;
  kind: KnowledgeKind;
  /** Discovery order: 0 is the most significant subsystem. */
  rank: number;
  /** Every file of the subsystem, most central first (tests last). */
  files: string[];
  /** Fingerprint of the subsystem's files and their content hashes; changes when a file changes, joins, or leaves. */
  fingerprint: string;
  routes: string[];
  tables: string[];
  tests: string[];
  ciJobs: string[];
  dependencies: KnowledgeDependencies;
  /** Centrality per file path (importers + callers). */
  centrality: Record<string, number>;
}

export const KIND_TITLES: Record<KnowledgeKind, string> = {
  architecture: "Architecture overview",
  authentication: "Authentication",
  authorization: "Authorization",
  database: "Database and data model",
  api: "API and routes",
  background_jobs: "Background jobs",
  billing: "Billing and payments",
  integrations: "Integrations",
  testing: "Testing",
  deployment: "Deployment and CI",
  security: "Security",
  frontend: "Frontend",
  other: "Other",
};

/** Keyword → subsystem kind. Matched against whole path / name tokens (a trailing plural "s" is ignored). */
const KEYWORDS: Record<Exclude<KnowledgeKind, "architecture" | "other">, string[]> = {
  authentication: ["auth", "authn", "authentication", "login", "logout", "signin", "signup", "session", "oauth", "sso", "saml", "oidc", "jwt", "password", "credential", "passport", "identity", "mfa", "totp"],
  authorization: ["authz", "authorization", "authorize", "permission", "rbac", "acl", "policy", "policies", "role", "guard", "entitlement"],
  billing: ["billing", "stripe", "payment", "invoice", "subscription", "checkout", "pricing", "price", "charge", "refund", "tax", "paddle", "braintree", "plan"],
  background_jobs: ["queue", "job", "worker", "cron", "scheduler", "schedule", "bullmq", "celery", "sidekiq", "consumer", "producer", "task"],
  database: ["db", "database", "schema", "migration", "migrate", "model", "orm", "sql", "drizzle", "prisma", "entity", "entities", "repository", "dao", "seed"],
  api: ["api", "route", "router", "routes", "controller", "handler", "endpoint", "rest", "graphql", "rpc", "trpc", "resolver", "middleware"],
  integrations: ["webhook", "integration", "github", "gitlab", "bitbucket", "slack", "discord", "twilio", "sendgrid", "mailer", "email", "smtp", "connector", "s3"],
  testing: ["fixture", "mock", "e2e", "playwright", "cypress", "jest", "vitest", "pytest", "testing"],
  deployment: ["deploy", "deployment", "docker", "dockerfile", "compose", "terraform", "k8s", "kubernetes", "helm", "infra", "ansible", "nginx", "procfile", "workflows", "ci"],
  security: ["security", "crypto", "encrypt", "encryption", "secret", "csrf", "sanitize", "sanitizer", "xss", "ssrf", "redact", "cors", "ratelimit", "captcha", "vault"],
  frontend: ["component", "components", "page", "view", "ui", "style", "styles", "css", "layout", "frontend", "hook", "hooks", "theme"],
};

/** Ties between equally strong signals go to the earlier kind. */
const KIND_ORDER: KnowledgeKind[] = [
  "authentication",
  "authorization",
  "billing",
  "background_jobs",
  "integrations",
  "security",
  "database",
  "api",
  "deployment",
  "frontend",
  "testing",
  "architecture",
  "other",
];

const KEYWORD_KIND = new Map<string, KnowledgeKind>();
for (const kind of KIND_ORDER) {
  for (const k of KEYWORDS[kind as keyof typeof KEYWORDS] ?? []) if (!KEYWORD_KIND.has(k)) KEYWORD_KIND.set(k, kind);
}

const FRONTEND_EXT = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html)$/i;
const DEPLOY_FILE = /(^|\/)(dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|procfile|[\w.-]+\.tf|fly\.toml|vercel\.json|netlify\.toml|app\.yaml|\.dockerignore)$/i;

/** Lowercase tokens of a name: split on separators and camelCase. */
export function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function kindOfToken(token: string): KnowledgeKind | undefined {
  return KEYWORD_KIND.get(token) ?? (token.length > 3 && token.endsWith("s") ? KEYWORD_KIND.get(token.slice(0, -1)) : undefined);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** The directory a file's cluster is named after: its first two directory levels ("" for root files). */
export function clusterDir(p: string): string {
  return dirOf(p).split("/").filter(Boolean).slice(0, 2).join("/");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Package name of an unresolved import (`@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`, `a.b.c` → `a`). */
export function packageName(target: string): string | null {
  let t = target.trim().replace(/^node:/, "");
  if (!t || t.startsWith(".") || t.startsWith("/") || t.startsWith("@/") || t.startsWith("~/") || t.startsWith("#") || /^[a-z]+:\/\//i.test(t)) return null;
  if (t.startsWith("@")) {
    const [scope, name] = t.split("/");
    return scope && name ? `${scope}/${name}` : null;
  }
  t = t.split("/")[0]!;
  if (!t.includes("-") && t.includes(".")) t = t.split(".")[0]!;
  return /^[\w.-]+$/.test(t) ? t : null;
}

const normPkg = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");

interface Scored {
  kind: KnowledgeKind;
  score: number;
}

/** The strongest keyword / tag signal of a file, or null below the threshold. */
function scoreFile(f: DiscoveryFile, symbolNames: string[]): Scored | null {
  const scores = new Map<KnowledgeKind, number>();
  const add = (k: KnowledgeKind | undefined, w: number) => {
    if (k) scores.set(k, (scores.get(k) ?? 0) + w);
  };
  const dirs = dirOf(f.path).split("/").filter(Boolean);
  const base = f.path.slice(f.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  // Directory names say more than file names; each distinct kind counts once per source.
  for (const k of new Set(dirs.flatMap(tokensOf).map(kindOfToken))) add(k, 3);
  for (const k of new Set(tokensOf(base).map(kindOfToken))) add(k, 2);
  const symbolKinds = new Map<KnowledgeKind, number>();
  for (const n of symbolNames) for (const k of new Set(tokensOf(n).map(kindOfToken))) if (k) symbolKinds.set(k, (symbolKinds.get(k) ?? 0) + 1);
  for (const [k, n] of symbolKinds) add(k, Math.min(2, n));
  const tags = new Set(f.tags);
  if (tags.has("migration") || tags.has("schema")) add("database", 3);
  if (tags.has("route")) add("api", 3);
  if (tags.has("ci")) add("deployment", 4);
  if (DEPLOY_FILE.test(f.path)) add("deployment", 4);
  if (FRONTEND_EXT.test(f.path)) add("frontend", 1);
  let best: Scored | null = null;
  for (const kind of KIND_ORDER) {
    const score = scores.get(kind) ?? 0;
    if (score > (best?.score ?? 0)) best = { kind, score };
  }
  return best && best.score >= 2 ? best : null;
}

function fingerprint(fs: DiscoveryFile[]): string {
  const h = createHash("sha256");
  for (const f of [...fs].sort((a, b) => a.path.localeCompare(b.path))) h.update(f.path).update("\0").update(f.contentHash).update("\n");
  return h.digest("hex").slice(0, 32);
}

interface Group {
  slug: string;
  title: string;
  kind: KnowledgeKind;
  members: Set<number>;
  tests: Set<number>;
}

/**
 * Clusters indexed files into candidate subsystems (pure and deterministic). See the module comment for the signals.
 */
export function clusterSubsystems(input: DiscoveryInput): Subsystem[] {
  const byId = new Map(input.files.map((f) => [f.id, f]));
  const isTest = (f: DiscoveryFile) => f.tags.includes("test");
  const isCode = (f: DiscoveryFile) => f.tags.some((t) => ["source", "route", "schema", "migration", "ci", "config", "manifest"].includes(t)) || DEPLOY_FILE.test(f.path);
  const importers = new Map<number, number>();
  for (const e of input.imports) importers.set(e.to, (importers.get(e.to) ?? 0) + 1);
  const centrality = (id: number) => (importers.get(id) ?? 0) + (input.callers.get(id) ?? 0);
  const namesByFile = new Map<number, string[]>();
  for (const s of input.symbols) {
    if (!s.exported && !["route", "table", "model"].includes(s.kind)) continue;
    const list = namesByFile.get(s.fileId) ?? [];
    if (list.length < 50) list.push(s.name);
    namesByFile.set(s.fileId, list);
  }

  const groups = new Map<string, Group>();
  const groupOf = new Map<number, Group>();
  const group = (slug: string, title: string, kind: KnowledgeKind) => {
    let g = groups.get(slug);
    if (!g) {
      g = { slug, title, kind, members: new Set(), tests: new Set() };
      groups.set(slug, g);
    }
    return g;
  };
  const join = (g: Group, id: number) => {
    g.members.add(id);
    groupOf.set(id, g);
  };

  // 1. Keyword and tag signals.
  const sorted = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  const unassigned: DiscoveryFile[] = [];
  const testFiles: DiscoveryFile[] = [];
  for (const f of sorted) {
    if (isTest(f)) {
      testFiles.push(f);
      continue;
    }
    if (f.tags.includes("doc") || f.tags.includes("instructions")) continue;
    if (!isCode(f) && !FRONTEND_EXT.test(f.path)) continue;
    const s = scoreFile(f, namesByFile.get(f.id) ?? []);
    if (s && s.kind !== "testing") join(group(s.kind, KIND_TITLES[s.kind], s.kind), f.id);
    else if (s?.kind === "testing") join(group("testing", KIND_TITLES.testing, "testing"), f.id);
    else unassigned.push(f);
  }

  // 2. Import graph: unassigned files join the group they share the most import edges with.
  const neighbors = new Map<number, number[]>();
  for (const e of input.imports) {
    if (e.from === e.to) continue;
    pushTo(neighbors, e.from, e.to);
    pushTo(neighbors, e.to, e.from);
  }
  // Dense directories first: a directory with at least 3 unassigned code files is its own subsystem.
  const byDir = new Map<string, DiscoveryFile[]>();
  for (const f of unassigned) pushTo(byDir, clusterDir(f.path), f);
  const loose: DiscoveryFile[] = [];
  for (const [dir, fs] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const code = fs.filter((f) => f.tags.includes("source") || f.tags.includes("route"));
    if (dir && code.length >= 3) {
      const g = group(`dir-${slugify(dir)}`, dir, "other");
      for (const f of fs) join(g, f.id);
    } else loose.push(...fs);
  }
  // Then attach the rest by graph affinity, repeating so chains of imports settle (bounded).
  for (let pass = 0; pass < 3 && loose.length; pass++) {
    for (let i = loose.length - 1; i >= 0; i--) {
      const f = loose[i]!;
      const votes = new Map<Group, number>();
      for (const n of neighbors.get(f.id) ?? []) {
        const g = groupOf.get(n);
        if (g) votes.set(g, (votes.get(g) ?? 0) + 1);
      }
      let best: Group | null = null;
      let bestVotes = 0;
      for (const [g, v] of [...votes.entries()].sort(([a], [b]) => a.slug.localeCompare(b.slug))) {
        if (v > bestVotes) {
          best = g;
          bestVotes = v;
        }
      }
      if (best) {
        join(best, f.id);
        loose.splice(i, 1);
      }
    }
  }

  // 3. Tests: with the code they test (tested_by), else by their own keywords, else the testing subsystem.
  const testedBy = new Map<number, number[]>();
  for (const e of input.testedBy) pushTo(testedBy, e.test, e.source);
  for (const t of testFiles) {
    const owners = (testedBy.get(t.id) ?? []).map((s) => groupOf.get(s)).filter((g): g is Group => !!g);
    const owner = owners.sort((a, b) => a.slug.localeCompare(b.slug))[0];
    if (owner) {
      owner.tests.add(t.id);
      continue;
    }
    const s = scoreFile({ ...t, tags: t.tags.filter((x) => x !== "test") }, namesByFile.get(t.id) ?? []);
    const g = s && s.kind !== "testing" ? groups.get(s.kind) : undefined;
    if (g) g.tests.add(t.id);
    else group("testing", KIND_TITLES.testing, "testing").tests.add(t.id);
  }

  // 4. Architecture overview: instructions, top-level docs, and the most central files of the repository.
  const overview = sorted.filter((f) => f.tags.includes("instructions") || (f.tags.includes("doc") && !f.path.includes("/")) || f.tags.includes("manifest"));
  const central = sorted
    .filter((f) => f.tags.includes("source") && centrality(f.id) > 0)
    .sort((a, b) => centrality(b.id) - centrality(a.id) || a.path.localeCompare(b.path))
    .slice(0, 15);
  const sourceCount = sorted.filter((f) => f.tags.includes("source")).length;
  if (sourceCount >= 5 || overview.length) {
    const g = group("architecture", KIND_TITLES.architecture, "architecture");
    for (const f of [...overview, ...central]) g.members.add(f.id);
  }

  // Rank: the overview first, then by size and centrality (keyword subsystems weigh double).
  const weight = (g: Group) => {
    let w = 0;
    for (const id of g.members) w += 1 + centrality(id);
    return (g.kind === "other" ? 1 : 2) * w + g.tests.size * 0.5;
  };
  const viable = [...groups.values()].filter((g) => {
    if (g.kind === "architecture") return g.members.size > 0;
    const code = [...g.members].filter((id) => !isTest(byId.get(id)!)).length;
    return g.kind === "testing" ? g.members.size + g.tests.size >= 2 : code >= 1;
  });
  viable.sort((a, b) => (a.kind === "architecture" ? -1 : b.kind === "architecture" ? 1 : weight(b) - weight(a) || a.slug.localeCompare(b.slug)));
  const chosen = viable.slice(0, MAX_SUBSYSTEMS);

  // Facts per subsystem.
  const subsystemOfFile = new Map<number, Group>();
  for (const g of chosen) if (g.kind !== "architecture") for (const id of g.members) subsystemOfFile.set(id, g);
  const symbolsByFile = new Map<number, { name: string; kind: string }[]>();
  for (const s of input.symbols) pushTo(symbolsByFile, s.fileId, s);
  const declared = new Map(input.declared.map((d) => [normPkg(d.name), d]));
  const externalByFile = new Map<number, string[]>();
  for (const e of input.externalImports) pushTo(externalByFile, e.fileId, e.target);
  const outgoing = new Map<number, number[]>();
  for (const e of input.imports) pushTo(outgoing, e.from, e.to);

  return chosen.map((g, rank) => {
    const rankFiles = (ids: Iterable<number>) =>
      [...ids]
        .map((id) => byId.get(id)!)
        .sort((a, b) => centrality(b.id) - centrality(a.id) || a.path.localeCompare(b.path));
    const members = rankFiles(g.members);
    const tests = rankFiles(g.tests);
    const all = [...members, ...tests];
    const ofKind = (kinds: string[]) => [...new Set(members.flatMap((f) => (symbolsByFile.get(f.id) ?? []).filter((s) => kinds.includes(s.kind)).map((s) => s.name)))].slice(0, MAX_FACTS);

    const internal = new Map<string, { path: string; subsystem: string | null; imports: number }>();
    for (const f of members) {
      for (const to of outgoing.get(f.id) ?? []) {
        if (g.members.has(to)) continue;
        const target = byId.get(to);
        if (!target) continue;
        const owner = subsystemOfFile.get(to);
        const key = owner ? `s:${owner.slug}` : `d:${dirOf(target.path) || "."}`;
        const cur = internal.get(key) ?? { path: owner ? owner.title : dirOf(target.path) || ".", subsystem: owner?.slug ?? null, imports: 0 };
        cur.imports++;
        internal.set(key, cur);
      }
    }
    const external = new Map<string, { name: string; imports: number; version: string | null }>();
    for (const f of members) {
      for (const target of externalByFile.get(f.id) ?? []) {
        const name = packageName(target);
        if (!name) continue;
        const dep = declared.get(normPkg(name));
        if (declared.size && !dep) continue;
        const cur = external.get(name) ?? { name, imports: 0, version: dep?.versionSpec ?? null };
        cur.imports++;
        external.set(name, cur);
      }
    }

    return {
      slug: g.slug,
      title: g.title,
      kind: g.kind,
      rank,
      files: all.map((f) => f.path),
      fingerprint: fingerprint(all),
      routes: ofKind(["route"]),
      tables: ofKind(["table", "model"]),
      tests: tests.map((f) => f.path).slice(0, MAX_FACTS),
      ciJobs: ofKind(["ci_job"]),
      dependencies: {
        internal: [...internal.values()].sort((a, b) => b.imports - a.imports || a.path.localeCompare(b.path)).slice(0, 10),
        external: [...external.values()].sort((a, b) => b.imports - a.imports || a.name.localeCompare(b.name)).slice(0, 15),
      },
      centrality: Object.fromEntries(all.map((f) => [f.path, centrality(f.id)])),
    };
  });
}

/** Loads what discovery needs from the index (one repository, tenant-scoped). */
export async function loadDiscoveryInput(db: Db, scope: RepoScope): Promise<DiscoveryInput> {
  const repoFiles = await db
    .select({ id: files.id, path: files.path, tags: files.tags, contentHash: files.contentHash })
    .from(files)
    .where(scoped(files, scope.orgId, eq(files.repoId, scope.repoId), sql`not (${files.tags} @> array['generated']::text[])`))
    .orderBy(files.path)
    .limit(MAX_FILES);
  const inRepo = (kinds: ("import" | "tested_by")[]) => scoped(edges, scope.orgId, eq(edges.repoId, scope.repoId), inArray(edges.kind, kinds));
  const [imports, tested, callerRows, symbolRows, external, declared] = await Promise.all([
    db
      .selectDistinct({ from: edges.fromFileId, to: edges.toFileId })
      .from(edges)
      .where(and(inRepo(["import"]), isNotNull(edges.toFileId)))
      .limit(MAX_EDGES),
    db
      .selectDistinct({ source: edges.fromFileId, test: edges.toFileId })
      .from(edges)
      .where(and(inRepo(["tested_by"]), isNotNull(edges.toFileId)))
      .limit(MAX_EDGES),
    db
      .select({ fileId: symbols.fileId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(edges)
      .innerJoin(symbols, eq(edges.toSymbolId, symbols.id))
      .where(and(scoped(edges, scope.orgId, eq(edges.repoId, scope.repoId), eq(edges.kind, "call")), eq(symbols.orgId, scope.orgId)))
      .groupBy(symbols.fileId),
    db
      .select({ fileId: symbols.fileId, name: symbols.name, kind: symbols.kind, exported: symbols.exported })
      .from(symbols)
      .where(
        scoped(
          symbols,
          scope.orgId,
          eq(symbols.repoId, scope.repoId),
          sql`(${symbols.exported} or ${symbols.kind} in ('route', 'table', 'model', 'ci_job'))`,
        ),
      )
      .limit(MAX_EDGES),
    db
      .selectDistinct({ fileId: edges.fromFileId, target: edges.targetName })
      .from(edges)
      .where(and(inRepo(["import"]), isNull(edges.toFileId)))
      .limit(MAX_EDGES),
    db
      .selectDistinct({ name: repoDependencies.name, versionSpec: repoDependencies.versionSpec })
      .from(repoDependencies)
      .where(scoped(repoDependencies, scope.orgId, eq(repoDependencies.repoId, scope.repoId))),
  ]);
  return {
    files: repoFiles,
    imports: imports.flatMap((e) => (e.to === null ? [] : [{ from: e.from, to: e.to }])),
    testedBy: tested.flatMap((e) => (e.test === null ? [] : [{ source: e.source, test: e.test }])),
    callers: new Map(callerRows.map((r) => [r.fileId, r.n])),
    symbols: symbolRows,
    externalImports: external,
    declared,
  };
}

/** Candidate subsystems of an indexed repository (R6.12). */
export async function discoverSubsystems(db: Db, scope: RepoScope): Promise<Subsystem[]> {
  return clusterSubsystems(await loadDiscoveryInput(db, scope));
}
