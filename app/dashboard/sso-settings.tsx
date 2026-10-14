import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { addSsoDomain, removeSsoDomain, saveSsoConnection, setSsoEnforcement, verifySsoDomain } from "./actions";

// Settings → People: single sign-on for this workspace (admins only).
export async function SsoSettings({ token, organizationId }: { token: string; organizationId: Id<"organizations"> }) {
  const { connection: c, domains } = await backend().query(api.sso.settings, { token, organizationId });
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  const verified = domains.filter((d) => d.verified).length;
  return <section aria-labelledby="sso-heading">
    <h2 id="sso-heading">Single sign-on</h2>
    <p className="muted">Connect your identity provider with SAML 2.0 or OpenID Connect. People sign in with their work email; an address counts as verified only on a domain you prove below with a DNS TXT record.</p>
    {c?.protocol === "saml" && base && <p className="muted">Service provider entity ID and metadata: <code>{`${base}/api/sso/saml/${c._id}`}</code> · ACS URL: <code>{`${base}/api/sso/saml/${c._id}/acs`}</code></p>}
    {c?.protocol === "oidc" && base && <p className="muted">Redirect URI: <code>{`${base}/api/sso/oidc/callback`}</code></p>}
    <form action={saveSsoConnection} className="form-grid">
      <input type="hidden" name="organizationId" value={organizationId} />
      <label>Protocol<select name="protocol" defaultValue={c?.protocol ?? "saml"}><option value="saml">SAML 2.0</option><option value="oidc">OpenID Connect</option></select></label>
      <label>Name<input name="name" required maxLength={100} defaultValue={c?.name ?? "Company SSO"} /></label>
      <label>SAML sign-in URL<input name="samlEntryPoint" type="url" defaultValue={c?.samlEntryPoint ?? ""} placeholder="https://idp.example.com/sso/saml" /></label>
      <label>SAML IdP entity ID (optional)<input name="samlIdpIssuer" defaultValue={c?.samlIdpIssuer ?? ""} /></label>
      <label className="wide">SAML signing certificate (PEM)<textarea name="samlIdpCert" rows={3} defaultValue={c?.samlIdpCert ?? ""} /></label>
      <label>OIDC issuer<input name="oidcIssuer" type="url" defaultValue={c?.oidcIssuer ?? ""} placeholder="https://login.example.com" /></label>
      <label>OIDC client ID<input name="oidcClientId" defaultValue={c?.oidcClientId ?? ""} /></label>
      <label>OIDC client secret<input name="oidcClientSecret" type="password" autoComplete="off" placeholder={c?.hasClientSecret ? "Saved; leave blank to keep" : ""} /></label>
      <label>New members from SSO<select name="jitRole" defaultValue={c?.jitRole ?? "none"}><option value="none">Invite only</option><option value="member">Join as member</option><option value="viewer">Join as viewer</option></select></label>
      <label className="check"><input type="checkbox" name="active" defaultChecked={c?.active ?? true} />Connection active</label>
      <button className="primary">Save SSO connection</button>
    </form>
    {c && <>
      <h3>Domains</h3>
      {domains.map((d) => <div key={d._id} className="row">
        <p><strong>{d.domain}</strong> · {d.verified ? "verified" : <>add TXT <code>{d.txtName}</code> = <code>{d.txtValue}</code></>}</p>
        {!d.verified && <form action={verifySsoDomain}><input type="hidden" name="domainId" value={d._id} /><button>Check DNS</button></form>}
        <form action={removeSsoDomain}><input type="hidden" name="domainId" value={d._id} /><button>Remove</button></form>
      </div>)}
      <form action={addSsoDomain} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId} /><label>Domain<input name="domain" required placeholder="example.com" /></label><button>Add domain</button></form>
      <form action={setSsoEnforcement} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId} /><input type="hidden" name="enforce" value={c.enforce ? "false" : "true"} />
        <p>{c.enforce ? "SSO is required for this workspace (owners can still use other sign-in methods)." : verified ? "SSO is optional." : "Verify a domain to require SSO."}</p>
        {(c.enforce || (verified > 0 && c.active)) && <button>{c.enforce ? "Stop requiring SSO" : "Require SSO"}</button>}
      </form>
    </>}
  </section>;
}
