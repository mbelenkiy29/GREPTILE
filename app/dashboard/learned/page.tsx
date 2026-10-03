import { LearnedList } from "@/components/dashboard/LearnedList";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { listLearnedPatterns } from "@/lib/learning";
import { editPattern, removePattern } from "./actions";
import { RulesNav } from "@/components/dashboard/RulesNav";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function LearnedPage() {
  const { orgId, role } = await requireOrg();
  const manage = can(role, "rules.manage");
  const rows = await listLearnedPatterns(db(), orgId);
  const items = rows.map((r) => ({ ...r.pattern, repoFullName: r.repoFullName }));
  return (
    <>
      <PageHeader title="Learned" />
      <RulesNav current="learned" />
      <p className="dim">
        Conventions inferred from reactions and replies on OpenReview comments. Suppressed patterns are no longer
        reported; prioritized ones rank higher. Edit a description to generalize it, or change the signal to override
        what was inferred.
        {!manage && " Only owners and admins can edit them."}
      </p>
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
    </>
  );
}
