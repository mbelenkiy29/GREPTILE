import { z } from "zod";
import type { ChangedFile, SourceFile } from "./engine/types";

// Sequence diagrams are generated as structured data grounded in exact source quotes, then
// rendered to Mermaid by OpenReview itself: labels are sanitized and the output is validated,
// so model text can never inject Mermaid directives or links.
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,30}$/);
export function diagramSchema(sources: SourceFile[], diff: ChangedFile[]) {
  const changed = new Set(diff.filter((d) => d.status !== "removed").map((d) => d.path));
  return z.object({
    diagram: z.object({
      title: z.string().min(3).max(120),
      participants: z.array(z.object({ id: identifier, label: z.string().min(1).max(60), filePath: z.string() })).min(2).max(8),
      messages: z.array(z.object({
        from: identifier, to: identifier, label: z.string().min(1).max(80),
        kind: z.enum(["call", "return", "async"]).optional(),
        evidence: z.object({ filePath: z.string(), startLine: z.number().int().positive(), quote: z.string().min(1).max(400) }),
      })).min(1).max(20),
    }).nullable(),
  }).superRefine((value, ctx) => {
    const d = value.diagram;
    if (!d) return;
    const ids = new Set(d.participants.map((p) => p.id));
    if (ids.size !== d.participants.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Participant ids must be unique" });
    if (new Set(d.participants.map((p) => p.filePath)).size < 2) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A sequence diagram needs participants from at least two files; return {diagram:null} otherwise" });
    for (const p of d.participants) if (!sources.some((s) => s.path === p.filePath)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Participant file was not supplied: " + p.filePath });
    for (const [i, m] of d.messages.entries()) {
      if (!ids.has(m.from) || !ids.has(m.to)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["diagram", "messages", i], message: "Messages must reference declared participant ids" });
      const source = sources.find((s) => s.path === m.evidence.filePath);
      const lines = source?.content.split("\n").slice(m.evidence.startLine - 1, m.evidence.startLine - 1 + m.evidence.quote.split("\n").length).join("\n");
      if (!source || lines?.trim() !== m.evidence.quote.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["diagram", "messages", i, "evidence"], message: "Evidence quote must exactly match supplied source lines at the stated 1-based line" });
    }
    if (!d.messages.some((m) => changed.has(m.evidence.filePath))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one message must be evidenced in a changed file" });
  });
}
export type SequenceDiagram = NonNullable<z.infer<ReturnType<typeof diagramSchema>>["diagram"]>;

const text = (value: string) => value.replace(/[\r\n;#:%{}[\]<>`"|\\]/g, " ").replace(/-+>+|<+-+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "step";
export function renderSequence(d: SequenceDiagram): string {
  const arrow = { call: "->>", return: "-->>", async: "-)" } as const;
  return ["sequenceDiagram", ...d.participants.map((p) => `    participant ${p.id} as ${text(p.label)}`), ...d.messages.map((m) => `    ${m.from}${arrow[m.kind ?? "call"]}${m.to}: ${text(m.label)}`)].join("\n");
}
// Accepts only the restricted subset renderSequence emits.
export function validSequence(source: string): boolean {
  const lines = source.split("\n");
  if (lines[0] !== "sequenceDiagram" || lines.length < 4 || lines.length > 40) return false;
  const declared = new Set<string>();
  for (const line of lines.slice(1)) {
    const participant = /^ {4}participant ([A-Za-z][A-Za-z0-9_]{0,30}) as ([^\n;#:%{}[\]<>`"|\\]{1,80})$/.exec(line);
    if (participant) { declared.add(participant[1]); continue; }
    const message = /^ {4}([A-Za-z][A-Za-z0-9_]{0,30})(->>|-->>|-\))([A-Za-z][A-Za-z0-9_]{0,30}): ([^\n;#:%{}[\]<>`"|\\]{1,80})$/.exec(line);
    if (!message || !declared.has(message[1]) || !declared.has(message[3])) return false;
  }
  return declared.size >= 2;
}
// Generate a diagram only when the change plausibly alters an interaction between components:
// changed files in two or more directories, or a changed file plus a graph-related context file.
export function diagramEligible(diff: ChangedFile[], context: { path: string; reason: string }[]) {
  const changed = diff.filter((d) => d.status !== "removed" && d.patch.trim());
  if (!changed.length) return false;
  const components = new Set(changed.map((d) => d.path.split("/").slice(0, -1).join("/") || "."));
  return components.size >= 2 || context.some((c) => !changed.some((d) => d.path === c.path) && /caller|dependency|graph|exact symbol/.test(c.reason));
}
