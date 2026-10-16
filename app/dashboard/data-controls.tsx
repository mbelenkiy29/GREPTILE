import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend } from "../../src/server";
import { cancelWorkspaceDeletion, requestWorkspaceDeletion, saveDataSettings } from "./actions";

const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC";
// Settings → Data & deletion: data sharing, retention and workspace deletion.
export async function DataControls({ token, organizationId }: { token: string; organizationId: Id<"organizations"> }) {
  const s = await backend().query(api.dataControls.settings, { token, organizationId });
  const admin = ["owner", "admin"].includes(s.role);
  return <>
    {s.deletion && <p role="alert">This workspace is scheduled for deletion {s.deletion.status === "purging" ? "and is being deleted now" : `on ${when(s.deletion.scheduledFor)}`}.</p>}
    <section aria-labelledby="data-heading">
      <h2 id="data-heading">Data sharing and retention</h2>
      <form action={saveDataSettings} className="form-grid"><fieldset disabled={!admin} className="wide">
        <input type="hidden" name="organizationId" value={organizationId} />
        <label>Use of this workspace&apos;s review data outside the workspace<select name="dataSharing" defaultValue={s.dataSharing}>
          <option value="private">Private: never used outside this workspace (default)</option>
          <option value="aggregate">Aggregate counts only (reviews and findings by category and severity) may be included in operator statistics</option>
        </select></label>
        <label>Keep reviews and findings for (days, blank = until deleted)<input type="number" name="reviewRetentionDays" min={7} max={3650} defaultValue={s.reviewRetentionDays ?? ""} /></label>
        <label>Keep transcripts (agent runs, chat and pull request Q&amp;A) for (days, blank = until deleted)<input type="number" name="transcriptRetentionDays" min={7} max={3650} defaultValue={s.transcriptRetentionDays ?? ""} /></label>
        <button>Save data settings</button>
      </fieldset></form>
      {!admin && <p className="muted">Only workspace owners and admins can change these settings.</p>}
    </section>
    <section aria-labelledby="delete-heading">
      <h2 id="delete-heading">Delete this workspace</h2>
      <p className="muted">Deletion starts {s.graceDays} day{s.graceDays === 1 ? "" : "s"} after you request it, and you can cancel until then. It removes every review, finding, rule, index, setting, member and file of this workspace; personal accounts stay. Uninstall the GitHub App and disconnect other providers yourself, from each provider&apos;s settings.</p>
      {s.role !== "owner" ? <p className="muted">Only the workspace owner can delete it.</p>
        : s.deletion?.status === "scheduled" ? <form action={cancelWorkspaceDeletion}><input type="hidden" name="organizationId" value={organizationId} /><button className="primary">Cancel deletion</button></form>
        : !s.deletion && <form action={requestWorkspaceDeletion} className="filter-bar"><input type="hidden" name="organizationId" value={organizationId} /><label>Type <strong>{s.name}</strong> to confirm<input name="confirmName" required autoComplete="off" /></label><button>Delete workspace</button></form>}
    </section>
  </>;
}
