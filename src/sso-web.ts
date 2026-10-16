import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { decryptCredential } from "./credentials";
import { backend } from "./server";
import { oidcConfiguration, samlServiceProvider } from "./sso";

// Web-server side of SSO: connection lookup with the backend secret, the SAML request cache kept in
// Convex (so any server instance can validate InResponseTo), and protocol clients for a connection.
const secret = () => process.env.SERVICE_SECRET ?? "";
export const ssoBase = (requestUrl: string) => (process.env.APP_URL ?? new URL(requestUrl).origin).replace(/\/+$/, "");
export type LoginConnection = NonNullable<Awaited<ReturnType<typeof loginConnection>>>;
export const loginConnection = (by: { email?: string; connectionId?: string }) => backend().query(api.sso.forLogin, { secret: secret(), ...by });
export const samlCache = {
  async saveAsync(key: string, value: string) { await backend().mutation(api.sso.cacheSave, { secret: secret(), key, value }); return { value, createdAt: Date.now() }; },
  getAsync: (key: string) => backend().query(api.sso.cacheGet, { secret: secret(), key }),
  removeAsync: async (key: string | null) => key ? backend().mutation(api.sso.cacheRemove, { secret: secret(), key }) : null,
};
export function samlFor(base: string, c: LoginConnection) {
  if (c.protocol !== "saml" || !c.samlEntryPoint || !c.samlIdpCert) throw new Error("Not a SAML connection");
  return samlServiceProvider(base, { id: c.id, entryPoint: c.samlEntryPoint, idpCert: c.samlIdpCert, ...(c.samlIdpIssuer ? { idpIssuer: c.samlIdpIssuer } : {}) }, samlCache);
}
export function oidcFor(c: LoginConnection) {
  if (c.protocol !== "oidc" || !c.oidcIssuer || !c.oidcClientId || !c.oidcClientSecret) throw new Error("Not an OIDC connection");
  return oidcConfiguration({ issuer: c.oidcIssuer, clientId: c.oidcClientId, clientSecret: decryptCredential(c.oidcClientSecret, `${c.organizationId}:sso`) });
}
export const signInSso = (args: { connectionId: string; subject: string; email?: string; emailVerifiedByIdp?: boolean; name: string; assertionId?: string; assertionExpiresAt?: number; sessionHash: string; userAgent?: string }) =>
  backend().mutation(api.sso.signIn, { secret: secret(), ...args, connectionId: args.connectionId as Id<"ssoConnections"> });
