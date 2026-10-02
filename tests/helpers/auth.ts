import type { AuthConfig } from "@/lib/auth/config";
import { SESSION_COOKIE } from "@/lib/auth/cookies";
import { createSession } from "@/lib/auth/sessions";
import { newUserId } from "@/lib/auth/users";
import { createOrg } from "@/lib/data/orgs";
import type { Db } from "@/lib/db";
import { authAccounts, memberships, users } from "@/lib/db/schema";
import { encryptSecret } from "@/lib/crypto";

export const TEST_SECRET = "test-app-secret-0123456789";
export const NOW = new Date("2026-03-01T12:00:00Z");

export const testAuthConfig: AuthConfig = {
  appUrl: "https://review.example.com",
  nodeEnv: "test",
  sessionTtlDays: 30,
  appSecret: TEST_SECRET,
  githubWebUrl: "https://github.example",
  githubApiUrl: "https://api.github.example",
  githubClientId: "Iv1.testclient",
  githubClientSecret: "test-client-secret",
  devLogin: false,
};

/** Parsed Set-Cookie headers of a response, keyed by cookie name. */
export function setCookies(res: Response): Map<string, { value: string; attrs: Map<string, string> }> {
  const out = new Map<string, { value: string; attrs: Map<string, string> }>();
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...rest] = line.split(";").map((s) => s.trim());
    const eq = pair!.indexOf("=");
    const attrs = new Map<string, string>();
    for (const a of rest) {
      const i = a.indexOf("=");
      attrs.set((i < 0 ? a : a.slice(0, i)).toLowerCase(), i < 0 ? "" : a.slice(i + 1));
    }
    out.set(pair!.slice(0, eq), { value: decodeURIComponent(pair!.slice(eq + 1)), attrs });
  }
  return out;
}

export interface FakeGitHubOptions {
  githubId?: number;
  login?: string;
  name?: string | null;
  accessToken?: string;
  expiresIn?: number | null;
  emails?: { email: string; primary: boolean; verified: boolean }[] | { status: number };
  exchange?: Record<string, unknown> | { status: number };
  userStatus?: number;
  /** Installation ids visible to the user, split into pages of `pageSize`. */
  installations?: number[];
  installationsStatus?: number;
  pageSize?: number;
}

export interface RecordedCall {
  url: string;
  method: string;
  authorization: string | null;
  body: Record<string, unknown> | undefined;
}

/** A fake github.example / api.github.example for the OAuth and user-to-server endpoints. */
export function fakeGitHub(opts: FakeGitHubOptions = {}) {
  const calls: RecordedCall[] = [];
  const api = testAuthConfig.githubApiUrl;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    if (url === `${testAuthConfig.githubWebUrl}/login/oauth/access_token`) {
      if (opts.exchange && "status" in opts.exchange && typeof opts.exchange.status === "number") {
        return new Response("upstream error", { status: opts.exchange.status });
      }
      return Response.json(
        opts.exchange ?? {
          access_token: opts.accessToken ?? "ghu_firsttoken000000000000000000000000",
          token_type: "bearer",
          ...(opts.expiresIn === null ? {} : { expires_in: opts.expiresIn ?? 28_800 }),
        },
      );
    }
    if (url === `${api}/user`) {
      if (opts.userStatus) return new Response("boom", { status: opts.userStatus });
      return Response.json({
        id: opts.githubId ?? 4242,
        login: opts.login ?? "octo",
        name: opts.name === undefined ? "Octo Cat" : opts.name,
        avatar_url: "https://avatars.github.example/u/4242",
      });
    }
    if (url.startsWith(`${api}/user/emails`)) {
      if (opts.emails && "status" in opts.emails) return new Response("forbidden", { status: opts.emails.status });
      return Response.json(
        opts.emails ?? [
          { email: "old@example.com", primary: false, verified: true },
          { email: "Octo@Example.com", primary: true, verified: true },
        ],
      );
    }
    if (url.startsWith(`${api}/user/installations`)) {
      if (opts.installationsStatus) return new Response("nope", { status: opts.installationsStatus });
      const ids = opts.installations ?? [];
      const size = opts.pageSize ?? 100;
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const slice = ids.slice((page - 1) * size, page * size);
      const headers = new Headers({ "content-type": "application/json" });
      if (page * size < ids.length) headers.set("link", `<${api}/user/installations?per_page=100&page=${page + 1}>; rel="next"`);
      return new Response(
        JSON.stringify({ total_count: ids.length, installations: slice.map((id) => ({ id, account: { login: `acct${id}` } })) }),
        { headers },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchImpl, calls };
}

let nextGitHubId = 9_000_000;

/** A user (optionally with a stored GitHub token) who owns a fresh org, plus a session cookie in that org. */
export async function userWithOrg(
  db: Db,
  input: { login: string; orgName?: string; githubToken?: { token: string; expiresAt: Date | null } },
) {
  const [user] = await db
    .insert(users)
    .values({ id: newUserId(), name: input.login, githubLogin: input.login, email: `${input.login}@example.com`, githubId: nextGitHubId++ })
    .returning();
  if (input.githubToken) {
    await db.insert(authAccounts).values({
      userId: user!.id,
      provider: "github",
      providerAccountId: String(user!.githubId),
      login: input.login,
      accessTokenEnc: encryptSecret(input.githubToken.token),
      accessTokenExpiresAt: input.githubToken.expiresAt,
    });
  }
  const org = await createOrg(db, { name: input.orgName ?? `${input.login} org`, createdBy: user!.id });
  const session = await signedInCookie(db, user!.id, org.id);
  return { user: user!, org, ...session };
}

/** Creates a session and returns its token and `Cookie` header value. */
export async function signedInCookie(db: Db, userId: string, activeOrgId: string | null, now: Date = NOW) {
  const s = await createSession(db, { userId, activeOrgId, now, ttlDays: testAuthConfig.sessionTtlDays });
  return { token: s.token, sessionId: s.id, cookie: `${SESSION_COOKIE}=${s.token}` };
}

/** Adds an existing user to an org with a role. */
export async function addMember(db: Db, orgId: string, userId: string, role: "owner" | "admin" | "member") {
  await db.insert(memberships).values({ orgId, userId, role });
}

/** A bare user row. */
export async function makeUser(db: Db, login: string, email: string | null = `${login}@example.com`) {
  const [user] = await db.insert(users).values({ id: newUserId(), name: login, githubLogin: login, email }).returning();
  return user!;
}
