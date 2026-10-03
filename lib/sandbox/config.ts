/**
 * Runtime validation settings (R4.5) as a repository declares them, in `openreview.json` (read at the PR's base
 * commit, so a pull request cannot change what runs for it) or in the repo's dashboard settings.
 */
import { z } from "zod";
import type { RuntimeValidationConfig } from "@/lib/db/schema";

/**
 * A Docker image reference: `[registry[:port]/]name[/name...][:tag][@sha256:digest]`, lower-case path components.
 * Strict, so the reference can go into an API path and query without escaping surprises.
 */
export const IMAGE_REF = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables the sandbox sets itself; a repository cannot override them. */
const RESERVED_ENV = new Set(["HOME", "PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "npm_config_proxy", "npm_config_https_proxy"]);

const command = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((c) => !c.includes("\0"), "must not contain NUL characters");

export const runtimeValidationSchema = z.strictObject({
  enabled: z.boolean(),
  image: z.string().trim().max(255).regex(IMAGE_REF, "must be a Docker image reference such as node:22-bookworm-slim").optional(),
  install: command.optional(),
  test: command,
  timeoutSec: z.number().int().min(10).max(7200).optional(),
  network: z.enum(["none", "install-only"]).optional(),
  env: z
    .record(
      z.string().regex(ENV_NAME, "must be an environment variable name").refine((k) => !RESERVED_ENV.has(k), "is set by the sandbox"),
      z.string().max(1000).refine((v) => !v.includes("\0"), "must not contain NUL characters"),
    )
    .refine((e) => Object.keys(e).length <= 50, "at most 50 variables")
    .optional(),
}) satisfies z.ZodType<RuntimeValidationConfig>;

export type { RuntimeValidationConfig };

/** `image` with an explicit tag (`:latest` when it has neither tag nor digest), as the engine pulls it. */
export function withTag(image: string): string {
  if (image.includes("@")) return image;
  const lastSlash = image.lastIndexOf("/");
  return image.slice(lastSlash + 1).includes(":") ? image : `${image}:latest`;
}

/** Whether `image` is allowed by the comma-separated SANDBOX_ALLOWED_IMAGES list (`*` wildcards; empty = any). */
export function imageAllowed(image: string, allowlist: string | undefined): boolean {
  const patterns = (allowlist ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!patterns.length) return true;
  const tagged = withTag(image);
  return patterns.some((p) => {
    const re = new RegExp(`^${p.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(image) || re.test(tagged);
  });
}
