import { z } from "zod";

const COMMENT_TYPES = ["logic", "security", "style"] as const;

/** Dashboard-editable review settings for a repo (overridden by tracewise.json). */
export const repoSettingsSchema = z
  .object({
    strictness: z.enum(["low", "medium", "high"]).optional(),
    commentTypes: z.array(z.enum(COMMENT_TYPES)).min(1).optional(),
    ignore: z.array(z.string().trim().min(1)).max(200).optional(),
    context: z.array(z.string().trim().min(1)).max(50).optional(),
  })
  .strict();
