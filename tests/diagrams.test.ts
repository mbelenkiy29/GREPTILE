import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { diagramEligible, diagramSchema, renderSequence, validSequence, type SequenceDiagram } from "../src/diagrams";
import { reviewChange } from "../src/engine/review";
import type { ChangedFile, ModelProvider, ModelRequest, SourceFile } from "../src/engine/types";

const head = "b".repeat(40);
const files: SourceFile[] = [
  { path: "web/checkout.ts", sha: head, content: "import { charge } from '../api/payments';\nexport async function checkout(cart) {\n  const receipt = await charge(cart.totalCents);\n  return receipt.id;\n}" },
  { path: "api/payments.ts", sha: head, content: "export async function charge(cents) {\n  return gateway.capture({ amount: cents / 100 });\n}" },
];
const diff: ChangedFile[] = [
  { path: "web/checkout.ts", status: "modified", patch: "@@ -1,5 +1,5 @@\n import { charge } from '../api/payments';\n export async function checkout(cart) {\n-  const receipt = await charge(cart.total);\n+  const receipt = await charge(cart.totalCents);\n   return receipt.id;\n }" },
  { path: "api/payments.ts", status: "modified", patch: "@@ -1,3 +1,3 @@\n export async function charge(cents) {\n-  return gateway.capture({ amount: cents });\n+  return gateway.capture({ amount: cents / 100 });\n }" },
];
const valid: SequenceDiagram = {
  title: "Checkout charges the payment gateway",
  participants: [{ id: "Checkout", label: "checkout()", filePath: "web/checkout.ts" }, { id: "Payments", label: "payments.charge()", filePath: "api/payments.ts" }],
  messages: [
    { from: "Checkout", to: "Payments", label: "charge(totalCents)", kind: "call", evidence: { filePath: "web/checkout.ts", startLine: 3, quote: "  const receipt = await charge(cart.totalCents);" } },
    { from: "Payments", to: "Checkout", label: "capture(amount = cents / 100)", kind: "return", evidence: { filePath: "api/payments.ts", startLine: 2, quote: "  return gateway.capture({ amount: cents / 100 });" } },
  ],
};

test("diagram schema accepts grounded diagrams and rejects invented evidence or single-component diagrams", () => {
  const schema = diagramSchema(files, diff);
  assert.ok(schema.safeParse({ diagram: valid }).success);
  assert.ok(schema.safeParse({ diagram: null }).success);
  const bad = (diagram: unknown) => schema.safeParse({ diagram }).success;
  assert.equal(bad({ ...valid, messages: [{ ...valid.messages[0], evidence: { ...valid.messages[0].evidence, quote: "  await chargeEverything();" } }] }), false);
  assert.equal(bad({ ...valid, messages: [{ ...valid.messages[0], to: "Ghost" }] }), false);
  assert.equal(bad({ ...valid, participants: valid.participants.map((p) => ({ ...p, filePath: "web/checkout.ts" })) }), false);
  assert.equal(bad({ ...valid, participants: [...valid.participants, { id: "Bank", label: "bank", filePath: "unsupplied.ts" }] }), false);
  assert.equal(diagramSchema(files, []).safeParse({ diagram: valid }).success, false, "evidence must touch a changed file");
});

test("rendered Mermaid is sanitized and limited to a validated sequence subset", () => {
  const hostile: SequenceDiagram = { ...valid, participants: [{ ...valid.participants[0], label: "a; click Checkout call alert() %%{init: {}}%%" }, valid.participants[1]], messages: [{ ...valid.messages[0], label: "x\n  Payments->>Checkout: injected --> <script>" }] };
  const rendered = renderSequence(hostile);
  assert.ok(validSequence(rendered));
  assert.equal(rendered.split("\n").length, 4);
  assert.doesNotMatch(rendered, /;|%%|<script>|-->(?!>)|\n {2}Payments->>/);
  assert.equal(renderSequence(valid), "sequenceDiagram\n    participant Checkout as checkout()\n    participant Payments as payments.charge()\n    Checkout->>Payments: charge(totalCents)\n    Payments-->>Checkout: capture(amount = cents / 100)");
  for (const source of ["graph TD\n A-->B", "sequenceDiagram\n    participant A as a\n    A->>B: undeclared", "sequenceDiagram\n    participant A as a\n    participant B as b\n    click A call alert()", "sequenceDiagram\n    participant A as a"]) assert.equal(validSequence(source), false, source);
});

test("diagrams are only attempted for cross-component interactions", () => {
  assert.equal(diagramEligible(diff, []), true);
  assert.equal(diagramEligible([diff[0]], []), false);
  assert.equal(diagramEligible([diff[0]], [{ path: "api/payments.ts", reason: "dependency/caller/test" }]), true);
  assert.equal(diagramEligible([{ ...diff[0], status: "removed" }], [{ path: "x.ts", reason: "graph" }]), false);
});

const usage = (task: string) => ({ task, provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 1, latencyMs: 0, estimatedCost: 0, cached: false });
const model = (diagram: unknown, tasks: string[] = []): ModelProvider => ({
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    tasks.push(request.task);
    const value = request.task.startsWith("review:") ? { findings: [] } : request.task === "diagram" ? { diagram } : { summary: "Checkout now sends cents and payments divide by 100 before capture.", reviewScore: { value: 4, reason: "No verified findings; the interaction change is small and grounded." } };
    return { value: schema.parse(value), usage: usage(request.task) };
  },
});
const input = { repository: "acme/shop", baseSha: "a".repeat(40), headSha: head, title: "Charge in cents", description: "", rules: [], mode: "fast" as const, files, diff };

test("reviews generate a grounded diagram into the summary, omit invalid ones, and honor the section toggle", async () => {
  const withDiagram = await reviewChange(input, model(valid));
  assert.equal(withDiagram.diagrams.length, 1);
  assert.match(withDiagram.summary, /### Sequence diagram\n```mermaid\nsequenceDiagram\n/);
  assert.ok(withDiagram.usage.some((u) => u.task === "diagram"));
  const invalid = await reviewChange(input, model({ ...valid, messages: [{ ...valid.messages[0], evidence: { ...valid.messages[0].evidence, startLine: 1 } }] }));
  assert.deepEqual(invalid.diagrams, []);
  assert.doesNotMatch(invalid.summary, /### Sequence diagram/);
  const none = await reviewChange(input, model(null));
  assert.deepEqual(none.diagrams, []);
  const tasks: string[] = [];
  const off = await reviewChange({ ...input, settings: { summarySections: ["overview", "findings"] } }, model(valid, tasks));
  assert.ok(!tasks.includes("diagram"));
  assert.deepEqual(off.diagrams, []);
});
