import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify, EncryptJWT, jwtDecrypt } from "jose";
import { createHash } from "node:crypto";
import { api } from "../convex/_generated/api";

export function backend() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("Configure NEXT_PUBLIC_CONVEX_URL");
  return new ConvexHttpClient(url);
}
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32)
    throw new Error("Configure SESSION_SECRET (at least 32 random characters)");
  return new TextEncoder().encode(value);
}
export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};
// Browser sessions carry `sid` (a random ID whose hash is stored server-side); API-key calls sign
// short-lived tokens without one.
export async function signSession(userId: string, sid?: string) {
  return new SignJWT(sid ? { sid } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("openreview")
    .setAudience("openreview")
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}
export async function session() {
  const token = (await cookies()).get("openreview_session")?.value;
  if (!token) redirect("/");
  try {
    await jwtVerify(token, secret(), {
      issuer: "openreview",
      audience: "openreview",
      algorithms: ["HS256"],
    });
  } catch {
    redirect("/");
  }
  // Server-side check: revoked or expired sessions (sign-out elsewhere, removal) end here.
  if (!(await backend().query(api.identity.sessionValid, { token }).catch(() => false))) redirect("/?signedout=1");
  return token;
}
export async function current() {
  const token = await session();
  return { token, ...(await backend().query(api.users.me, { token })) };
}
export async function seal(data: Record<string, unknown>) {
  return new EncryptJWT(data)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(createHash("sha256").update(secret()).digest());
}
export async function unseal(token: string) {
  return (
    await jwtDecrypt(token, createHash("sha256").update(secret()).digest(), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    })
  ).payload;
}
export function origin() {
  const value = process.env.APP_URL ?? "http://localhost:3000";
  return new URL(value).origin;
}
