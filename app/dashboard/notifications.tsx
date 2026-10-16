import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { repositoryDisplay } from "../../src/provider-display";
import { disconnectSlack, removeSlackChannel, saveNotificationPreferences, saveSlackChannel, setNotificationEmail } from "./actions";

const eventLabels: Record<string, string> = { "review.completed": "Review completed", "finding.high": "High-severity findings" };
const levelLabels: Record<string, string> = { off: "Off", mine: "My pull requests", all: "All repositories I can access" };
// Settings → Notifications: Slack workspace + channel links (admins) and personal email preferences.
export async function NotificationsPanel({ token, organizationId, repositories, filters }: { token: string; organizationId: Id<"organizations">; repositories: Doc<"repositories">[]; filters: Record<string, string | undefined> }) {
  const s = await backend().query(api.notifications.settings, { token, organizationId });
  const name = (id: string) => { const r = repositories.find((x) => x._id === id); return r ? repositoryDisplay(r) : "Unavailable repository"; };
  return <>
    {filters.slack === "connected" && <p role="status">Slack is connected.</p>}
    {filters.slack === "error" && <p role="alert">Slack could not be connected. Try again, and check that the app&apos;s redirect URL matches this deployment.</p>}
    {filters.email === "verified" && <p role="status">Your notification email is verified.</p>}
    {filters.email === "invalid" && <p role="alert">That verification link is invalid or expired. Set your email again to get a new link.</p>}
    {s.admin && <section aria-labelledby="slack-heading">
      <h2 id="slack-heading">Slack</h2>
      {s.offline ? <p className="muted">Offline mode is on (OPENREVIEW_OFFLINE=true), so Slack is turned off for this deployment.</p>
        : !s.slackConfigured ? <p className="muted">Slack is not configured for this deployment. An operator must create the Slack app from docs/slack-app-manifest.yml and set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET and SLACK_SIGNING_SECRET.</p>
        : !s.slack ? <p><a className="button" href={`/api/slack/install?organization=${organizationId}`}>Add to Slack</a></p>
        : <>
          <p>Connected to <strong>{s.slack.teamName}</strong>. In linked channels, members can mention @OpenReview with a question about the linked repositories, and run <code>/openreview status</code>.</p>
          {s.channels.map((c) => <article key={c._id} className="preference">
            <div className="row"><h3><code>{c.channelId}</code></h3><span className="badge">{c.qa ? "Q&A on" : "Notifications only"}</span></div>
            <p className="muted">{c.events.length ? c.events.map((e) => eventLabels[e] ?? e).join(", ") : "No notifications"} · {c.repositoryIds.length ? c.repositoryIds.map(name).join(", ") : "All repositories"}</p>
            <form action={removeSlackChannel}><input type="hidden" name="channelId" value={c._id} /><button className="danger">Unlink channel</button></form>
          </article>)}
          <form action={saveSlackChannel} className="form-grid">
            <input type="hidden" name="organizationId" value={organizationId} />
            <label>Slack channel ID<input name="channelId" required pattern="[CG][A-Z0-9]{8,12}" placeholder="C0123456789" /></label>
            <fieldset><legend>Notify about</legend>{Object.entries(eventLabels).map(([k, label]) => <label className="check" key={k}><input type="checkbox" name="events" value={k} defaultChecked={k === "finding.high"} /> {label}</label>)}</fieldset>
            <fieldset className="wide"><legend>Repositories (none selected = notifications for all; Q&A needs 1–5)</legend>{repositories.map((r) => <label className="check" key={r._id}><input type="checkbox" name="repositoryIds" value={r._id} /> {repositoryDisplay(r)}</label>)}</fieldset>
            <label className="check wide"><input type="checkbox" name="qa" /> Answer @OpenReview questions in this channel about the selected repositories (anyone in the channel can ask; answers cite code)</label>
            <button>Link channel</button>
          </form>
          <form action={disconnectSlack}><input type="hidden" name="organizationId" value={organizationId} /><button className="danger">Disconnect Slack</button></form>
        </>}
    </section>}
    <section aria-labelledby="email-heading">
      <h2 id="email-heading">Email</h2>
      {!s.emailConfigured && <p className="muted">{s.offline ? "Offline mode is on (OPENREVIEW_OFFLINE=true), so email is turned off." : "Email delivery is not configured for this deployment (RESEND_API_KEY and EMAIL_FROM)."} Preferences are saved but nothing is sent.</p>}
      <form action={setNotificationEmail} className="form-grid">
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>Notification email<input name="email" type="email" required maxLength={254} defaultValue={s.preferences.email ?? ""} /></label>
        <p className="muted">{s.preferences.email ? (s.preferences.verified ? "Verified." : "Waiting for verification: check your inbox for the link.") : "No address set."}</p>
        <button>{s.preferences.email ? "Change and verify" : "Save and verify"}</button>
      </form>
      <form action={saveNotificationPreferences} className="form-grid">
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>Review completed<select name="reviewCompleted" defaultValue={s.preferences.reviewCompleted}>{Object.entries(levelLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>High-severity findings<select name="highSeverity" defaultValue={s.preferences.highSeverity}>{Object.entries(levelLabels).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <button>Save email preferences</button>
      </form>
    </section>
  </>;
}
