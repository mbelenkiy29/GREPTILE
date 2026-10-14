import { api } from "../../convex/_generated/api";
import { backend } from "../../src/server";
import { revokeSession, signOutEverywhere } from "./actions";

const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
// Settings → Account: linked sign-in methods and active sessions (revoke one, or everywhere).
export async function AccountPanel({ token }: { token: string }) {
  const data = await backend().query(api.identity.sessions, { token });
  const linked = new Set(data.identities.map((i) => i.provider));
  return <>
    <section aria-labelledby="methods-heading">
      <h2 id="methods-heading">Sign-in methods</h2>
      <ul>{data.identities.map((i) => <li key={i.provider + (i.email ?? "")}>{i.provider}{i.email ? ` · ${i.email}${i.emailVerified ? " (verified)" : ""}` : ""} · last used {when(i.lastLoginAt)}</li>)}</ul>
      <p className="muted">Accounts join automatically only when both sides have the same verified email. To add another method to this account, link it while signed in:</p>
      <div className="row">
        {!linked.has("github") && <a className="button" href="/api/auth/login?link=1&next=/dashboard/settings/account">Link GitHub</a>}
        {process.env.GITLAB_OAUTH_CLIENT_ID && !linked.has("gitlab") && <a className="button" href="/api/auth/gitlab/login?link=1&next=/dashboard/settings/account">Link GitLab</a>}
        {process.env.GOOGLE_CLIENT_ID && !linked.has("google") && <a className="button" href="/api/auth/google/login?link=1&next=/dashboard/settings/account">Link Google</a>}
      </div>
    </section>
    <section aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Active sessions</h2>
      {data.sessions.length === 0 ? <p className="muted">This browser uses a session from before session tracking; sign out everywhere to end it.</p> : <ul>{data.sessions.map((s) => <li key={s._id}>{s.provider} sign-in · {s.userAgent ?? "Unknown browser"} · started {when(s.createdAt)}{s.current ? <strong> · this browser</strong> : <form action={revokeSession} className="inline-form"><input type="hidden" name="sessionId" value={s._id} /><button className="small">Sign out</button></form>}</li>)}</ul>}
      <form action={signOutEverywhere}><button className="danger">Sign out everywhere</button></form>
      <p className="muted">Removal from a workspace also signs you out everywhere and revokes your API keys and bridges for that workspace.</p>
    </section>
  </>;
}
