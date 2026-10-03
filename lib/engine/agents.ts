/**
 * Specialized reviewer agents (R6.7). Each agent has a focused system prompt and sees the same shared context
 * bundle; agents run in parallel with bounded concurrency and any of them may return zero findings.
 */
import { z } from "zod";
import { errorMessage } from "@/lib/log";
import { callJson, mapLimit, record, type EngineContext } from "./calls";
import { dataHandlingInstructions } from "./prompt";
import { SEVERITIES, type AgentId, type AgentRunRecord, type ReviewMode } from "./types";

export const MAX_PARALLEL_AGENTS = 4;

export const evidenceSchema = z.object({
  path: z.string().describe("File the evidence is in"),
  startLine: z.number().int().describe("First line of the snippet (new-file numbering for changed files)"),
  endLine: z.number().int(),
  snippet: z.string().describe("Code copied verbatim from the diff or a repo_code block"),
  why: z.string().describe("How this code shows the problem"),
});

export const candidateSchema = z.object({
  title: z.string().describe("One-line statement of the problem"),
  description: z.string().describe("What is wrong and under which inputs or conditions it misbehaves"),
  impact: z.string().describe("What breaks for users or the system if this ships"),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1).describe("Probability the problem is real, 0..1, calibrated"),
  path: z.string().describe("Changed file the comment anchors to, exactly as in the diff"),
  startLine: z.number().int().describe("New-file line number from the diff"),
  endLine: z.number().int().describe("Last line of the anchored range (same as startLine for one line)"),
  symbol: z.string().nullable().describe("Enclosing function/class name, or null"),
  evidence: z.array(evidenceSchema).describe("At least one item; the first is the anchored code itself"),
  suggestedFix: z.string().describe("How to fix it, in one or two sentences"),
  suggestion: z
    .string()
    .nullable()
    .describe("Exact replacement code for startLine..endLine (no diff markers, same indentation), or null"),
  ruleId: z.string().nullable().describe('Id of the team rule this enforces (e.g. "rule:12"), or null'),
});

export const agentOutputSchema = z.object({ findings: z.array(candidateSchema) });

export type Candidate = z.infer<typeof candidateSchema>;

export interface AgentSpec {
  id: AgentId;
  title: string;
  focus: string;
  /** Higher runs first when the mode caps how many agents run. */
  priority: number;
}

export const AGENTS: Record<AgentId, AgentSpec> = {
  correctness: {
    id: "correctness",
    title: "correctness",
    priority: 100,
    focus: `Correctness: logic errors, wrong conditions and off-by-one errors, unhandled null/undefined/error paths,
broken invariants, resource leaks, and changes that break the callers, callees, importers, or dependents shown in
the repository code (changed signatures, return shapes, thrown errors, removed behavior). Cross-file breakage is the
most valuable thing you can find: when a changed function is called elsewhere, check every call site you are shown.`,
  },
  security: {
    id: "security",
    title: "security",
    priority: 90,
    focus: `Security: injection (SQL, shell, path, template, header), missing authentication or authorization,
missing organization/tenant checks on data access, secrets or tokens committed or logged, unsafe deserialization,
SSRF, path traversal, open redirects, XSS, weak or misused cryptography, insecure session/token handling, and risky
dependency changes. Report only issues reachable from the changed code.`,
  },
  data: {
    id: "data",
    title: "data and persistence",
    priority: 80,
    focus: `Data safety: destructive or irreversible migrations, schema changes that existing code or data does not
satisfy (NOT NULL without defaults, dropped/renamed columns still read elsewhere), missing transactions around
multi-step writes, race conditions and lost updates, wrong query filters or joins, and anything that can lose or
corrupt data.`,
  },
  api_compat: {
    id: "api_compat",
    title: "API compatibility",
    priority: 70,
    focus: `API compatibility: breaking changes to exported functions, types, classes, HTTP routes, or event/payload
shapes that downstream consumers rely on. Use the callers, importers, dependents, and routes in the repository code to
find consumers that the change breaks, and name them in the evidence.`,
  },
  performance: {
    id: "performance",
    title: "performance",
    priority: 60,
    focus: `Performance: N+1 queries, network or database calls inside loops, unbounded queries or loops over
user-controlled sizes, repeated expensive work that could be hoisted or cached, expensive renders, and memory growth.
Only report costs that matter at realistic scale.`,
  },
  testing: {
    id: "testing",
    title: "testing",
    priority: 50,
    focus: `Testing: behavior changed by this PR that no test covers (only when a regression is plausible), edge cases
the PR's own tests miss, tests that assert the wrong thing, and mocks that hide the behavior under test. Only comment on
tests relevant to this change; never ask for tests of trivial code.`,
  },
  rules: {
    id: "rules",
    title: "team rules",
    priority: 40,
    focus: `Team rules and repository instructions: violations of the rules in <team_rules> and of conventions written
in repository instructions files (repo_doc blocks of kind "instructions" or "context_doc"). Every finding must cite
ruleId: the rule's id for a team rule, or "instructions:<path>" for an instructions file. Do not report anything that
no rule or instruction covers.`,
  },
};

export const SECURITY_FOCUS_CHECKLIST = `Security review checklist (dedicated security profile). Work through every item against the changed code:
1. Injection: SQL/NoSQL built from strings, shell commands, template rendering, header or log injection.
2. Authorization gaps: missing authentication, missing permission/role checks, and data access that does not filter
   by the caller's organization/tenant (multi-tenancy leaks).
3. Secrets: credentials, tokens, or keys in the diff (see <secret_scan>), and secrets written to logs or responses.
4. Unsafe deserialization: eval, pickle/yaml.load, unvalidated JSON shapes flowing into privileged code.
5. SSRF: server-side requests to URLs or hosts influenced by users.
6. Path traversal: file paths built from user input without normalization and containment checks.
7. Insecure redirects: redirect targets taken from user input without an allow-list.
8. Sensitive logging: personal data, tokens, or secrets in log lines or error messages.
9. Dependency risks: added or changed dependencies in manifests (unpinned, typosquat-looking, known-risky packages).`;

export function agentSystemPrompt(agent: AgentSpec, opts: { securityFocus: boolean; commentStyle: "concise" | "detailed" }): string {
  const parts = [
    `You are OpenReview's ${agent.title} reviewer. You review one pull request using context retrieved from the whole repository.`,
    `Focus: ${agent.focus}`,
  ];
  if (opts.securityFocus && agent.id === "security") parts.push(SECURITY_FOCUS_CHECKLIST);
  if (opts.securityFocus && agent.id === "correctness") {
    parts.push("This is a security review: report only logic errors that have security consequences (auth, tenant isolation, data exposure, integrity).");
  }
  parts.push(
    dataHandlingInstructions(),
    `Output rules:
- Returning no findings is correct when nothing meaningful is wrong; never comment to fill a category. Prefer no
  finding over a speculative one.
- Only report problems this pull request introduces or exposes, in files whose <diff> block has role="review".
  Diffs with role="context" are for understanding only.
- Anchor path/startLine/endLine to new-file line numbers printed at the left of the diff lines.
- evidence: at least one item. The first item is the anchored code; add the code elsewhere in the repository that
  shows why it is wrong (e.g. a caller that now passes the wrong arguments). Copy snippets verbatim; never invent code.
- confidence is the probability (0..1) that the problem is real and would misbehave; be calibrated.
- severity: critical = data loss, security breach, or outage; high = wrong behavior in common paths; medium = wrong
  behavior in edge cases; low = minor but real.
- suggestion: exact replacement code for startLine..endLine only when the fix is mechanical and local, else null.
- ${opts.commentStyle === "concise" ? "Keep description and impact to one or two sentences each." : "Explain the problem fully: the failing scenario, why it happens, and its consequences."}`,
  );
  return parts.join("\n\n");
}

export interface AgentResult {
  agent: AgentId;
  candidates: Candidate[];
  run: AgentRunRecord;
}

export interface AgentPlan {
  id: AgentId;
  /** Gateway mode for this agent (the security profile runs the security agent at deep effort). */
  mode: ReviewMode;
}

/** Runs the planned agents (≤ 4 at once) on the shared prompt. One agent failing never sinks the others. */
export async function runAgents(ctx: EngineContext, plan: AgentPlan[], prompt: string, opts: { securityFocus: boolean }): Promise<AgentResult[]> {
  const style = ctx.req.settings.commentStyle;
  return mapLimit(plan, MAX_PARALLEL_AGENTS, async (p): Promise<AgentResult> => {
    const spec = AGENTS[p.id];
    const res = await callJson(ctx, p.id, {
      task: "review",
      mode: p.mode,
      system: agentSystemPrompt(spec, { securityFocus: opts.securityFocus, commentStyle: style }),
      prompt,
      schema: agentOutputSchema,
      schemaName: "review_findings",
      ...(ctx.req.settings.model ? { model: ctx.req.settings.model } : {}),
    });
    const run: AgentRunRecord = res.ok
      ? { agent: p.id, status: "ok", model: res.value.model, usage: res.value.usage, costUsd: res.value.costUsd, latencyMs: res.value.latencyMs, candidates: res.value.data.findings.length, accepted: 0 }
      : {
          agent: p.id,
          status: "error",
          model: res.failure.model,
          usage: res.failure.usage,
          costUsd: res.failure.costUsd,
          latencyMs: res.failure.latencyMs,
          candidates: 0,
          accepted: 0,
          error: errorMessage(res.failure.error),
        };
    await record(ctx, run);
    return { agent: p.id, candidates: res.ok ? res.value.data.findings : [], run };
  });
}
