import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const anthropicFormats = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const bounds = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "pattern", "maxItems", "default"];

// Converts a zod response schema into a provider structured-output schema. Anthropic's grammar
// rejects length/number bounds and open objects, so those are stripped there; zod still enforces
// every constraint (and refinements) on the returned value. Returns undefined when the schema
// cannot be expressed (non-object root, any/never/record nodes), keeping prompt-only JSON mode.
export function structuredSchema(schema: z.ZodTypeAny, target: "anthropic" | "openai"): Record<string, unknown> | undefined {
  let json: Record<string, unknown>;
  try { json = zodToJsonSchema(schema, { $refStrategy: "none", effectStrategy: "input" }) as Record<string, unknown>; }
  catch { return undefined; }
  delete json.$schema; delete json.definitions;
  if (json.type !== "object") return undefined;
  let expressible = true;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const n: Record<string, unknown> = { ...(node as Record<string, unknown>) };
    if (target === "anthropic") {
      if (!Object.keys(n).length || "not" in n) { expressible = false; return n; }
      for (const key of bounds) delete n[key];
      if (typeof n.minItems === "number" && n.minItems > 1) n.minItems = 1;
      if (typeof n.format === "string" && !anthropicFormats.has(n.format)) delete n.format;
      if (n.oneOf) { n.anyOf = n.oneOf; delete n.oneOf; }
      if (n.type === "object") {
        if (n.additionalProperties && typeof n.additionalProperties === "object") expressible = false;
        n.additionalProperties = false;
      }
    }
    if (n.properties && typeof n.properties === "object") n.properties = Object.fromEntries(Object.entries(n.properties as Record<string, unknown>).map(([key, value]) => [key, walk(value)]));
    for (const key of ["items", "anyOf", "allOf", "oneOf"]) if (n[key] && typeof n[key] === "object") n[key] = walk(n[key]);
    if (n.additionalProperties && typeof n.additionalProperties === "object") n.additionalProperties = walk(n.additionalProperties);
    return n;
  };
  const result = walk(json) as Record<string, unknown>;
  return expressible ? result : undefined;
}
