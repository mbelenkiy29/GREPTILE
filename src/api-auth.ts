import { createHash } from "node:crypto";
import { api } from "../convex/_generated/api";
import { backend, signSession } from "./server";
export async function apiIdentity(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer or_") || authorization.length > 200)
    throw new Error("API key required");
  const hash = createHash("sha256")
    .update(authorization.slice(7))
    .digest("hex");
  const identity = await backend().query(api.apiKeys.resolve, {
    secret: process.env.SERVICE_SECRET ?? "",
    hash,
  });
  return { ...identity, token: await signSession(identity.userId) };
}
