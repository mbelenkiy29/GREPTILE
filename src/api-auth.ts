import { createHash } from "node:crypto";
import { z } from "zod";
import { api } from "../convex/_generated/api";
import { backend, signSession } from "./server";
import { hasScope, type ApiScope } from "./api-scopes";

export class ApiAuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) { super(message); }
}
// Resolves a Bearer API key to its workspace and owner, and requires a scope (default read).
export async function apiIdentity(request: Request, scope: ApiScope = "read") {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer or_") || authorization.length > 200)
    throw new ApiAuthError(401, "API key required");
  const hash = createHash("sha256")
    .update(authorization.slice(7))
    .digest("hex");
  let identity;
  try {
    identity = await backend().query(api.apiKeys.resolve, {
      secret: process.env.SERVICE_SECRET ?? "",
      hash,
    });
  } catch {
    throw new ApiAuthError(401, "Invalid or revoked API key");
  }
  if (!hasScope(identity.scopes, scope)) throw new ApiAuthError(403, `This API key does not have the ${scope} scope`);
  return { ...identity, token: await signSession(identity.userId) };
}
// Authentication/scope failures keep their status; callers fall back to their own error for the rest.
export function apiDenied(error: unknown) {
  return error instanceof ApiAuthError ? Response.json({ error: error.message }, { status: error.status }) : undefined;
}
export function apiFailure(error: unknown, fallback: { status: number; error: string }) {
  const denied = apiDenied(error);
  if (denied) return denied;
  if (error instanceof z.ZodError) return Response.json({ error: "Invalid request", issues: error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
  if (error instanceof SyntaxError) return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  return Response.json({ error: fallback.error }, { status: fallback.status });
}
