import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const findingSchema = z.object({
  path: z.string().describe("File path exactly as shown in the diff header"),
  line: z.number().int().describe("New-file line number from the diff that the comment anchors to"),
  endLine: z.number().int().nullable().describe("Last line of a multi-line issue, or null"),
  severity: z.enum(SEVERITIES),
  title: z.string().describe("One-line statement of the problem"),
  body: z.string().describe("Why it is a problem and its concrete impact; cite impacted code when relevant"),
  suggestion: z
    .string()
    .nullable()
    .describe("Exact replacement code for lines line..endLine (no diff markers), or null if no mechanical fix"),
  confidence: z.number().int().min(1).max(5).describe("1 = speculative, 5 = certain"),
  ruleId: z
    .string()
    .nullable()
    .optional()
    .describe('Id of the team rule this finding enforces, e.g. "rule:12", or null'),
});

export const reviewerOutputSchema = z.object({ findings: z.array(findingSchema) });

export type RawFinding = z.infer<typeof findingSchema>;

export interface Finding extends RawFinding {
  category: string;
  /** Reviewer agents that reported this (after dedupe). */
  agents: string[];
  score: number;
  /** The team rule this finding enforces, validated against the rules in scope (R2.1). */
  rule?: { id: string; text: string };
}
