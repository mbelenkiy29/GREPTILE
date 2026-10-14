import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import { SignJWT } from "jose";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { devinHandoff } from "../src/agent-links";

const modules = import.meta.glob("../convex/**/*.ts");

test("Send to Devin is hidden unless the viewer saved a key and the finding can be fixed", () => {
  expect(devinHandoff(false, true, "r1", "f1")).toBeUndefined();
  expect(devinHandoff(true, false, "r1", "f1")).toBeUndefined();
  expect(devinHandoff(true, true, "r1", "f1")).toEqual({ reviewId: "r1", finding: "f1" });
  expect(devinHandoff(true, true, "r1")).toEqual({ reviewId: "r1" });
});

test("Devin keys are per user, stored only as ciphertext, never returned by status, and removable", async () => {
  process.env.SERVICE_SECRET = "devin-service"; process.env.SESSION_SECRET = "devin-session-secret-at-least-32-characters";
  const t = convexTest(schema, modules);
  const login = async (githubId: number) => { const id = await t.mutation(api.users.login, { secret: "devin-service", githubId, login: "u" + githubId, avatar: "" }); return new SignJWT({}).setSubject(id).setProtectedHeader({ alg: "HS256" }).setIssuer("openreview").setAudience("openreview").setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET)); };
  const alice = await login(1), bob = await login(2);
  expect((await t.query(api.personalCredentials.status, { token: alice })).devin).toEqual({ configured: false });
  await expect(t.mutation(api.personalCredentials.set, { token: alice, kind: "devin", ciphertext: "apk_user_plaintext_key" })).rejects.toThrow(/Invalid credential/);
  await t.mutation(api.personalCredentials.set, { token: alice, kind: "devin", ciphertext: "aXY.dGFn.ZGF0YQ" });
  const status = await t.query(api.personalCredentials.status, { token: alice });
  expect(status.devin.configured).toBe(true);
  expect(JSON.stringify(status)).not.toMatch(/ZGF0YQ/);
  expect(await t.query(api.personalCredentials.ciphertext, { token: alice, kind: "devin" })).toBe("aXY.dGFn.ZGF0YQ");
  expect((await t.query(api.personalCredentials.status, { token: bob })).devin.configured).toBe(false);
  expect(await t.query(api.personalCredentials.ciphertext, { token: bob, kind: "devin" })).toBeNull();
  await t.mutation(api.personalCredentials.set, { token: alice, kind: "devin" });
  expect((await t.query(api.personalCredentials.status, { token: alice })).devin.configured).toBe(false);
});
