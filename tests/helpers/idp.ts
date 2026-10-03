/**
 * A fake OpenID Connect identity provider for SSO tests (R4.6): real RS256 keys from `jose`, a discovery document,
 * a JWKS endpoint, and a token endpoint that returns an ID token minted per test, all served through an injected
 * fetch (no network).
 */
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";

export const ISSUER = "https://idp.example.com/realms/acme";
export const CLIENT_ID = "openreview-client";
export const CLIENT_SECRET = "idp-client-secret-value";

export interface FakeIdp {
  fetch: typeof fetch;
  requests: { url: string; method: string; body: string | null; authorization: string | null }[];
  mint: (claims: JWTPayload, opts?: { now: Date; key?: "main" | "other"; kid?: string }) => Promise<string>;
  /** What the token endpoint returns next as the ID token. */
  arm: (fn: () => Promise<string>) => void;
}

export async function fakeIdp(opts: { issuer?: string; discoveryIssuer?: string } = {}): Promise<FakeIdp> {
  const issuer = opts.issuer ?? ISSUER;
  const main = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(main.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const requests: FakeIdp["requests"] = [];
  let pendingToken: (() => Promise<string>) | undefined;

  const mint: FakeIdp["mint"] = async (claims, o = { now: new Date() }) => {
    const iat = Math.floor(o.now.getTime() / 1000);
    return new SignJWT({ email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "k1" })
      .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
      .setAudience(claims.aud ?? CLIENT_ID)
      .setSubject(typeof claims.sub === "string" ? claims.sub : "idp-user-1")
      .setIssuedAt(typeof claims.iat === "number" ? claims.iat : iat)
      .setExpirationTime(typeof claims.exp === "number" ? claims.exp : iat + 300)
      .sign(o.key === "other" ? other.privateKey : main.privateKey);
  };

  const idp: FakeIdp = {
    requests,
    mint,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : null;
      requests.push({ url, method: init?.method ?? "GET", body, authorization: headers.get("authorization") });
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer: opts.discoveryIssuer ?? issuer,
          authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
          jwks_uri: `${issuer}/protocol/openid-connect/certs`,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (url === `${issuer}/protocol/openid-connect/certs`) return Response.json({ keys: [jwk] });
      if (url === `${issuer}/protocol/openid-connect/token`) {
        const params = new URLSearchParams(body ?? "");
        if (params.get("code") !== "good-code" || !params.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ id_token: await pendingToken!(), token_type: "Bearer" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
    arm: (fn) => {
      pendingToken = fn;
    },
  };
  return idp;
}

/** Resolver that maps every host to a public documentation-free address (for the SSRF guard). */
export const publicResolve = async () => ["93.184.216.34"];
