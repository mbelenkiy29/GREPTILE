import { cookies } from "next/headers";
import { SignInOptions } from "../../sign-in";
import { current } from "../../../src/server";
import { loopbackRedirect } from "../../../src/oauth-server";
import { pendingAuthorization } from "../../../src/oauth-consent";
import { approveAuthorization, denyAuthorization } from "./actions";

export const dynamic = "force-dynamic";
const scopeText: Record<string, string> = { read: "Read reviews, findings, rules and indexed code", write: "Request reviews, record feedback and suggest rules", admin: "Workspace administration through the API" };
// Consent for an MCP client. Shows who is asking, where the browser will be sent (hostname first, with a
// warning for loopback redirects that any local program could claim), the workspace and the scopes.
export default async function Consent() {
  const pending = await pendingAuthorization();
  if (!pending) return <main className="narrow"><h1>Authorization expired</h1><p>Start the connection again from your MCP client.</p></main>;
  const redirect = new URL(pending.redirectUri);
  const signedIn = Boolean((await cookies()).get("openreview_session")?.value);
  if (!signedIn) return <main className="narrow"><h1>Sign in to connect {pending.clientName}</h1><SignInOptions next="/oauth/consent" /></main>;
  const user = await current();
  const workspaces = user.organizations.filter((o) => o._id);
  return (
    <main className="narrow">
      <h1>Connect {pending.clientName} to OpenReview?</h1>
      <p>After you approve, OpenReview sends you to <strong>{redirect.host}</strong> (<code>{pending.redirectUri}</code>).</p>
      {loopbackRedirect(pending.redirectUri) && <p role="alert">This client redirects to your own computer ({redirect.hostname}). Approve only if you started this connection from an app you trust.</p>}
      <p className="muted">Client: <code>{pending.clientId}</code></p>
      <form action={approveAuthorization} className="form-grid">
        <label>Workspace<select name="organizationId" required>{workspaces.map((o) => <option key={o._id} value={o._id!}>{o.name} ({o.role})</option>)}</select></label>
        <fieldset className="wide"><legend>Access</legend>{pending.scopes.map((s) => <label key={s} className="check"><input type="checkbox" name="scopes" value={s} defaultChecked />{s}: {scopeText[s]}</label>)}</fieldset>
        <p className="muted wide">Access never exceeds your role in the workspace. Revoke it any time under Settings → API keys.</p>
        <button className="primary">Approve</button>
        <button formAction={denyAuthorization} formNoValidate>Deny</button>
      </form>
    </main>
  );
}
