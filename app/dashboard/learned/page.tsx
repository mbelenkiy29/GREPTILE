import { LearnedList } from "@/components/dashboard/LearnedList";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listLearnedPatterns } from "@/lib/learning";
import { editPattern, removePattern } from "./actions";

export default async function LearnedPage() {
  const { orgId } = await requireOrg();
  const rows = await listLearnedPatterns(db(), orgId);
  const items = rows.map((r) => ({ ...r.pattern, repoFullName: r.repoFullName }));
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Learned</h1>
      </div>
      <p className="dim">
        Conventions inferred from reactions and replies on Tracewise comments. Suppressed patterns are no longer
        reported; prioritized ones rank higher. Edit a description to generalize it, or change the signal to override
        what was inferred.
      </p>
      <LearnedList
        items={items}
        actions={(i) => (
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
        )}
      />
    </div>
  );
}
