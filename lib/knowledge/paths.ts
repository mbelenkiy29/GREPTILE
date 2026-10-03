/**
 * File paths in model output (R6.12): every path a knowledge entry mentions must exist in the repository's index.
 * Structured paths (key files, risk files) that do not exist are dropped; paths mentioned in prose are replaced
 * with a neutral marker so an entry never points readers at a file the model made up.
 */

/** Extensions of files a path-like token may name. */
const FILE_EXT = new Set(
  "ts tsx js jsx mjs cjs mts cts py pyi go rb java kt kts scala rs cs php swift c h cc cpp hpp m mm sql json yml yaml toml ini cfg conf md mdx rst txt prisma graphql gql proto sh bash zsh ps1 tf hcl css scss sass less html htm vue svelte astro ex exs erl dart lua r jl gradle xml properties env lock dockerfile".split(
    " ",
  ),
);

export const UNKNOWN_FILE = "[unknown file]";

function normalize(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
}

/** Whether a token reads as a file path: it names a file with a known extension, inside a directory or alone. */
export function looksLikeFilePath(token: string): boolean {
  const t = normalize(token.replace(/:\d+(?:-\d+)?$/, ""));
  if (!t || /\s/.test(t) || /^[a-z]+:\/\//i.test(token) || t.length > 300) return false;
  const base = t.slice(t.lastIndexOf("/") + 1);
  if (!base.includes(".") && base.toLowerCase() !== "dockerfile") return false;
  return FILE_EXT.has(extOf(t));
}

/** The repository's paths, for validating model output. */
export class KnownPaths {
  private readonly paths: Set<string>;
  private readonly basenames: Set<string>;

  constructor(paths: Iterable<string>) {
    this.paths = new Set(paths);
    this.basenames = new Set([...this.paths].map((p) => p.slice(p.lastIndexOf("/") + 1)));
  }

  /** The indexed path a model-written path refers to, or null when it does not exist. */
  resolve(path: string): string | null {
    const p = normalize(path.replace(/:\d+(?:-\d+)?$/, ""));
    return this.paths.has(p) ? p : null;
  }

  /** Whether a mention in prose refers to an existing file (a bare file name counts when some file has it). */
  private mentionExists(token: string): boolean {
    const p = normalize(token.replace(/:\d+(?:-\d+)?$/, ""));
    if (this.paths.has(p)) return true;
    return !p.includes("/") && this.basenames.has(p);
  }

  /** `text` with every path-like mention of a file that does not exist replaced by {@link UNKNOWN_FILE}. */
  scrub(text: string): string {
    // Inline code first: `path/to/file.ts` (or `file.ts`).
    let out = text.replace(/`([^`\n]{1,300})`/g, (whole, inner: string) => (looksLikeFilePath(inner) && !this.mentionExists(inner) ? UNKNOWN_FILE : whole));
    // Then bare paths with a directory, outside URLs and inline code.
    out = out.replace(/(^|[\s(["'])((?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]*[\w@-])(?=$|[\s)\]"',;:!?]|\.(?:\s|$))/gm, (whole, lead: string, token: string) => {
      if (!looksLikeFilePath(token) || this.mentionExists(token)) return whole;
      return `${lead}${UNKNOWN_FILE}`;
    });
    return out;
  }
}
