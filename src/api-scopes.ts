// API key scopes. admin includes write, write includes read; the key owner's workspace role still
// bounds every call (a scope never grants more than the owner has).
export const apiScopes = ["read", "write", "admin"] as const;
export type ApiScope = (typeof apiScopes)[number];
export const legacyScopes: ApiScope[] = ["read", "write", "admin"];
const rank: Record<ApiScope, number> = { read: 1, write: 2, admin: 3 };
export function hasScope(granted: readonly string[], required: ApiScope) {
  return granted.some((s) => (apiScopes as readonly string[]).includes(s) && rank[s as ApiScope] >= rank[required]);
}
