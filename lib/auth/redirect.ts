/**
 * Open-redirect protection (R6.1): post-sign-in destinations must be same-origin relative paths. Rejects
 * protocol-relative (`//evil.com`, also after dot-segment normalization: `/.//evil.com`), backslash tricks (`/\evil.com`), absolute URLs, and control characters.
 */

export const DEFAULT_AFTER_SIGN_IN = "/dashboard";
const MAX_LENGTH = 2048;

function hasControlCharacters(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export function safeNextPath(next: unknown, fallback: string = DEFAULT_AFTER_SIGN_IN): string {
  if (typeof next !== "string" || next.length === 0 || next.length > MAX_LENGTH) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  // Browsers treat "\" like "/", and strip tabs/newlines before parsing; refuse both outright.
  if (next.includes("\\") || hasControlCharacters(next)) return fallback;
  const base = "http://same-origin.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  // Dot segments collapse during parsing ("/.//evil.com" and "/a/..//evil.com" become "//evil.com"), so the
  // normalized path must be checked again: a result starting with "//" would be a protocol-relative redirect.
  if (url.pathname.startsWith("//")) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `/sign-in?next=<path>` for a page that needs a signed-in user. */
export function signInPath(next?: string | null, error?: string): string {
  const params = new URLSearchParams();
  const safe = next ? safeNextPath(next, "") : "";
  if (safe && safe !== DEFAULT_AFTER_SIGN_IN) params.set("next", safe);
  if (error) params.set("error", error);
  const q = params.toString();
  return q ? `/sign-in?${q}` : "/sign-in";
}
