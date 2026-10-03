import { LearnedList } from "@/components/dashboard/LearnedList";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listLearnedPatterns } from "@/lib/learning";
import { resetLearnedPreferences } from "../findings/actions";
import { editPattern, removePattern } from "./actions";

async function resetFromForm(formData: FormData) {
  "use server";
  await resetLearnedPreferences(formData);
}

export default async function LearnedPage() {
  const { orgId, role } = await requireOrg();
  const manage = can(role, "rules.manage");
  const rows = await listLearnedPatterns(db(), orgId);
  const items = rows.map((r) => ({ ...r.pattern, repoFullName: r.repoFullName }));
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Learned</h1>
      </div>
      <p className="dim">
        Conventions inferred from reactions, replies, and feedback on OpenReview findings. Suppressed patterns are no
        longer reported; prioritized ones rank higher. A suppressed category raises the confidence a finding in it
        needs. Edit a description to generalize it, or change the signal to override what was inferred; edited and
        explicitly ignored patterns are pinned.
        {!manage && " Only owners and admins can edit them."}
      </p>
      {manage && items.length > 0 && (
        <form action={resetFromForm} className="row">
          <label className="row">
            <input type="checkbox" name="includePinned" /> Include pinned preferences
          </label>
          <button className="button" type="submit">
            Reset learned preferences
          </button>
        </form>
      )}
      <LearnedList
        items={items}
        actions={
          manage
            ? (i) => (
                <>
                  <form action={editPattern} className="row">
                    <input type="hidden" name="id" value={i.id} />
                    <input name="description" defaultValue={i.description} aria-label="Description" size={50} />
                    <select name="signal" defaultValue={i.signal} aria-label="Signal">
                      <option value="suppress">Suppress</option>
                      <option value="boost">Prioritize</option>
                      <option value="neutral">Observe</option>
                    </select>
                    <button className="button" type="submit">Save</button>
                  </form>
                  <form action={removePattern}>
                    <input type="hidden" name="id" value={i.id} />
                    <button className="button" type="submit">Delete</button>
                  </form>
                </>
              )
            : undefined
        }
      />
    </div>
  );
}
