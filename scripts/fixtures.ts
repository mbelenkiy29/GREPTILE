import type { ReviewInput, SourceFile } from "../src/engine/types";
type Fixture = {
  id: string;
  expected: { path: string; category: string; terms: string[] } | null;
  input: ReviewInput;
  // Indexed repository files reachable only through agent tools (two or more hops from the change).
  repositoryFiles?: SourceFile[];
};
// Multi-hop: the defect only shows at a caller two hops away, which the pipeline payload omits.
function multiHop(id: string, category: string, before: string, after: string, context: Record<string, string>, repositoryOnly: Record<string, string>, terms: string[]): Fixture {
  return { ...fixture(id, category, before, after, context, terms), repositoryFiles: Object.entries(repositoryOnly).map(([path, content]) => ({ path, content, sha: "d" })) };
}
// Requirements check: a linked ticket file with provenance, as the Linear, Jira and Notion integrations
// supply it, and the identifier in the title.
function withTicket(f: Fixture, identifier: string, ticket: string): Fixture {
  const revision = "2026-10-01T00:00:00.000Z";
  return { ...f, input: { ...f.input, title: `${identifier}: ${f.input.title}`, files: [...f.input.files, { path: `requirements/linear/evaluation/${identifier}.md`, content: ticket, sha: revision, provenance: { repository: "Linear: Evaluation", revision, sourceUrl: `https://linear.app/evaluation/issue/${identifier}` } }] } };
}
function fixture(
  id: string,
  category: string,
  before: string,
  after: string,
  context: Record<string, string>,
  terms: string[],
): Fixture {
  const filePath = "src/change.ts";
  const patch = `@@ -1,${before.split("\n").length} +1,${after.split("\n").length} @@\n${before
    .split("\n")
    .map((s) => "-" + s)
    .join("\n")}\n${after
    .split("\n")
    .map((s) => "+" + s)
    .join("\n")}`;
  return {
    id,
    expected: terms.length ? { path: filePath, category, terms } : null,
    input: {
      repository: `evaluation/${id}`,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      title: `Change ${id}`,
      description: "Review the committed change.",
      mode: "standard",
      rules: [],
      diff: [{ path: filePath, status: "modified", patch }],
      files: [
        { path: filePath, content: after, sha: "b" },
        ...Object.entries(context).map(([path, content]) => ({
          path,
          content,
          sha: "c",
        })),
      ],
    },
  };
}
export const fixtures: Fixture[] = [
  multiHop(
    "multi-hop-currency",
    "correctness",
    "export function total(cents,qty) { return cents*qty; }",
    "export function total(cents,qty) { return (cents*qty)/100; }",
    { "src/cart.ts": "import { total } from './change';\nexport function checkoutAmount(cart) { return total(cart.priceInCents, cart.quantity); }" },
    { "src/payments.ts": "import { checkoutAmount } from './cart';\n// The payment provider requires integer cents.\nexport function charge(provider,cart) { return provider.charge({amount:checkoutAmount(cart),currency:'USD'}); }" },
    ["cents", "100", "dollar", "undercharg"],
  ),
  multiHop(
    "multi-hop-authorization",
    "security",
    "export function isAdmin(user) { return user.role === 'admin'; }",
    "export function isAdmin(user) { return user.role === 'admin' || user.isStaff === true; }",
    { "src/middleware.ts": "import { isAdmin } from './change';\nexport function requireAdmin(user) { if (!isAdmin(user)) throw new Error('forbidden'); }" },
    { "src/routes/admin.ts": "import { requireAdmin } from '../middleware';\n// Only administrators may erase customer data.\nexport function eraseAllCustomers(user, db) { requireAdmin(user); return db.customers.deleteMany({}); }" },
    ["staff", "admin", "privilege", "escalat"],
  ),
  multiHop(
    "multi-hop-retry-delay",
    "performance",
    "export function retryDelay(attempt) { return 1000 * 2 ** attempt; }",
    "export function retryDelay(attempt) { return 2 ** attempt; }",
    { "src/scheduler.ts": "import { retryDelay } from './change';\nexport function scheduleRetry(queue, job) { queue.later(job, retryDelay(job.attempt)); }" },
    { "src/queue.ts": "// later(job, delayMs): delay is in milliseconds.\nexport const queue = { later(job, delayMs) { setTimeout(() => job.run(), delayMs); } };" },
    ["millisecond", "1000", "retry", "hammer"],
  ),
  fixture(
    "clean-refactor",
    "correctness",
    "export function total(cents,qty) { return cents*qty; }",
    "export function total(cents,qty) { const amountInCents=cents*qty; return amountInCents; }",
    {
      "src/billing.ts": "import { total } from './change';\n// Payment provider amounts are integer cents.\nexport function charge(provider,cart) { return provider.charge({amount:total(cart.priceInCents,cart.quantity),currency:'USD'}); }",
      "tests/billing.test.ts": "import assert from 'node:assert/strict';\nimport { total } from '../src/change';\nassert.equal(total(250,2),500);",
    },
    [],
  ),
  fixture(
    "clean-guard",
    "security",
    "export function canAccess(user) { return !!user && user.active === true; }",
    "export function canAccess(user) { if(!user) return false; return user.active === true; }",
    {"src/route.ts": "import { canAccess } from './change';\nexport function privateRoute(user) { if (canAccess(user)) return process.env.PRIVATE_DATA; return null; }"},
    [],
  ),
  fixture(
    "authentication",
    "security",
    "export function canAccess(user) { return !!user && user.active === true; }",
    "export function canAccess(user) { return user?.active !== false; }",
    {
      "src/route.ts":
        "import { canAccess } from './change';\nexport function privateRoute(user) { if (canAccess(user)) return process.env.PRIVATE_DATA; return null; }",
    },
    ["missing", "undefined", "unauthenticated", "absent", "null"],
  ),
  fixture(
    "authorization",
    "security",
    "export async function getDocument(db, session, id) { return db.documents.findFirst({where:{id,orgId:session.orgId}}); }",
    "export async function getDocument(db, session, id) { return db.documents.findFirst({where:{id}}); }",
    {
      "src/route.ts":
        "import { getDocument } from './change';\nexport function route(request,session,db) { return getDocument(db,session,request.params.id); }",
    },
    ["organization", "tenant", "authorization", "access"],
  ),
  fixture(
    "null-handling",
    "correctness",
    'export function display(user) { return user?.name ?? "Unknown"; }',
    "export function display(user) { return user.name.toUpperCase(); }",
    {
      "src/route.ts":
        "import { display } from './change';\nexport function page(users,id) { return display(users.find(u=>u.id===id)); }",
    },
    ["undefined", "null", "missing", "crash"],
  ),
  fixture(
    "concurrency",
    "data",
    'export async function purchase(db,sku) { return db.transaction(async tx=>{const r=await tx.lock(sku); if(r.stock<1) throw Error("sold out"); await tx.decrement(sku);}); }',
    'export async function purchase(db,sku) { const r=await db.get(sku); if(r.stock<1) throw Error("sold out"); await db.decrement(sku); }',
    {
      "README.md":
        "Purchases run concurrently. Stock may never be negative. get and decrement are independent database operations; get does not acquire a lock.",
    },
    ["race", "concurrent", "stock", "oversell"],
  ),
  fixture(
    "data-loss",
    "data",
    "export async function purge(db,userId) { await db.events.deleteMany({where:{userId}}); }",
    "export async function purge(db,userId) { await db.events.deleteMany({}); }",
    {
      "src/route.ts":
        "import { purge } from './change';\nexport function deleteAccount(session,db) { return purge(db,session.userId); }",
    },
    ["all", "delete", "loss", "other"],
  ),
  fixture(
    "breaking-api",
    "compatibility",
    "export function profile(user) { return {id:user.id,name:user.name}; }",
    "export function profile(user) { return {userId:user.id,name:user.name}; }",
    {
      "src/client.ts":
        "import { profile } from './change';\nexport function link(user) { return '/users/'+profile(user).id; }",
    },
    ["id", "consumer", "undefined", "breaking"],
  ),
  fixture(
    "sql-query",
    "security",
    'export function search(db,q) { return db.query("SELECT * FROM users WHERE name = $1",[q]); }',
    "export function search(db,q) { return db.query(`SELECT * FROM users WHERE name = '${q}'`); }",
    {
      "src/route.ts":
        "import { search } from './change';\nexport function route(req,db) { return search(db,req.query.q); }",
    },
    ["injection", "sql", "untrusted"],
  ),
  fixture(
    "cross-file",
    "correctness",
    "export function total(cents,qty) { return cents*qty; }",
    "export function total(cents,qty) { return cents*qty/100; }",
    {
      "src/billing.ts":
        "import { total } from './change';\n// Payment provider amount is integer cents.\nexport function charge(provider,cart) { return provider.charge({amount:total(cart.priceInCents,cart.quantity),currency:'USD'}); }",
    },
    ["cents", "100", "undercharg", "unit"],
  ),
  fixture(
    "missing-validation",
    "security",
    'export function redirectTo(next) { if(!next.startsWith("/") || next.startsWith("//")) return "/"; return next; }',
    "export function redirectTo(next) { return next; }",
    {
      "src/login.ts":
        "import { redirectTo } from './change';\nexport function callback(request) { return Response.redirect(redirectTo(request.query.next)); }",
    },
    ["redirect", "external", "phish"],
  ),
  fixture(
    "regression",
    "correctness",
    "export function expiresAt(now,seconds) { return now+seconds*1000; }",
    "export function expiresAt(now,seconds) { return now+seconds; }",
    {
      "src/session.ts":
        "import { expiresAt } from './change';\nexport function session() { return { expiresAt:expiresAt(Date.now(),3600) }; }\nexport function valid(s) { return s.expiresAt>Date.now(); }",
    },
    ["milliseconds", "seconds", "1000", "expir"],
  ),
  // Hypothesis agents: the off-by-one only matters at the API two hops away, where pages are 1-based.
  multiHop(
    "hypothesis-page-offset",
    "correctness",
    "export function pageOffset(page, size) { return (page - 1) * size; }",
    "export function pageOffset(page, size) { return page * size; }",
    { "src/query.ts": "import { pageOffset } from './change';\nexport function listQuery(page, size) { return { offset: pageOffset(page, size), limit: size }; }" },
    { "src/api.ts": "import { listQuery } from './query';\n// Pages are 1-based: the first request is page=1.\nexport function listOrders(db, request) { return db.orders.find(listQuery(Number(request.query.page ?? 1), 50)); }" },
    ["page", "offset", "skip", "first", "1-based"],
  ),
  // Security agent: argument-array execFile replaced by a shell string built from request input.
  fixture(
    "security-command-injection",
    "security",
    "import { execFile } from 'node:child_process';\nexport function branchLog(branch, done) { execFile('git', ['log', '--oneline', branch], done); }",
    "import { exec } from 'node:child_process';\nexport function branchLog(branch, done) { exec('git log --oneline ' + branch, done); }",
    { "src/routes.ts": "import { branchLog } from './change';\nexport function handler(request, response) { branchLog(request.query.branch, (error, output) => response.send(output)); }" },
    ["shell", "inject", "command", "exec"],
  ),
  // Requirements check: the change adds the plan column the ticket asks for but drops the soft-delete filter it requires.
  withTicket(
    fixture(
      "requirements-soft-delete",
      "correctness",
      "export function exportRows(customers) { return customers.filter((c) => !c.deletedAt).map((c) => [c.id, c.email]); }",
      "export function exportRows(customers) { return customers.map((c) => [c.id, c.email, c.plan]); }",
      { "src/export.ts": "import { exportRows } from './change';\nexport function customerCsv(customers) { return exportRows(customers).map((row) => row.join(',')).join('\\n'); }" },
      ["deleted", "soft", "exclude", "requirement"],
    ),
    "PAY-7",
    "# PAY-7: Add the plan to the customer export\n\nAcceptance criteria:\n- The CSV export includes each customer's plan.\n- Soft-deleted customers (deletedAt set) must never appear in the export.\n",
  ),
];
