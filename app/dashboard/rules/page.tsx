import { RulesList, type RuleItem } from "@/components/dashboard/RulesList";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { listRepos } from "@/lib/data/installations";
import { listRules } from "@/lib/data/rules";
import { addRule, editRule, removeRule, setRuleStatus } from "./actions";

function toItem(r: Awaited<ReturnType<typeof listRules>>[number]): RuleItem {
  return { ...r.rule, repoFullName: r.repoFullName };
}

export default async function RulesPage() {
  const { orgId } = await requireOrg();
  const [active, candidates, repos] = await Promise.all([
    listRules(db(), orgId, { status: ["active"] }),
    listRules(db(), orgId, { status: ["candidate"] }),
    listRepos(db(), orgId),
  ]);
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Rules</h1>
      </div>
      <p className="dim">
        Write rules in plain English. Reviews enforce them on matching files and cite the rule in the comment. Rules can
        also live in a repository&apos;s <code>tracewise.json</code>.
      </p>

      <form action={addRule} className="comment">
        <label className="stack-sm">
          <span className="strong">New rule</span>
          <textarea name="text" required minLength={5} maxLength={2000} rows={2} placeholder="e.g. Database queries in API handlers must go through the repository layer, never raw SQL." />
        </label>
        <div className="row">
          <label>
            Scope{" "}
            <select name="repoId" defaultValue="">
              <option value="">All repositories</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Paths <input name="paths" placeholder="src/api/**, **/*.sql" />
          </label>
          <button className="button button-primary" type="submit">Add rule</button>
        </div>
      </form>

      {candidates.length > 0 && (
        <section className="stack-sm">
          <h2>Suggested from your reviewers ({candidates.length})</h2>
          <RulesList
            rules={candidates.map(toItem)}
            empty=""
            actions={(r) => (
              <>
                <form action={setRuleStatus}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <input type="hidden" name="status" value="active" />
                  <button className="button button-primary" type="submit">Approve</button>
                </form>
                <form action={setRuleStatus}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <input type="hidden" name="status" value="rejected" />
                  <button className="button" type="submit">Dismiss</button>
                </form>
              </>
            )}
          />
        </section>
      )}

      <section className="stack-sm">
        <h2>Active rules ({active.length})</h2>
        <RulesList
          rules={active.map(toItem)}
          empty="No rules yet."
          actions={(r) => (
            <>
              <form action={editRule} className="row">
                <input type="hidden" name="ruleId" value={r.id} />
                <input name="text" defaultValue={r.text} aria-label="Rule text" size={50} />
                <input name="paths" defaultValue={r.paths.join(", ")} aria-label="Paths" placeholder="all files" />
                <button className="button" type="submit">Save</button>
              </form>
              <form action={removeRule}>
                <input type="hidden" name="ruleId" value={r.id} />
                <button className="button" type="submit">Delete</button>
              </form>
            </>
          )}
        />
      </section>
    </div>
  );
}
