import { repositoryDisplay } from "../../../src/provider-display";
import Link from "next/link";
import { decideRuleSuggestion, requestRuleAssistant, saveRule } from "../actions";
import { status, Empty } from "./shared";
import type { DashboardContext } from "../load";

export function RulesSection({ ctx }: { ctx: DashboardContext }) {
  const { data, filters, isAdmin, organization, repoName, requestedRepository, rulesPage, scopes, selectedTeam, visibleRules } = ctx;
  return (
(
          <>
            <form className="toolbar" method="get" action="/dashboard/memory/rules">
              {selectedTeam&&<input type="hidden" name="team" value={selectedTeam._id}/>}
              <label>Rules for repository<select name="repository" defaultValue={requestedRepository??""}>
                <option value="">All accessible repositories</option>
                {data.repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}
              </select></label><button>Apply filter</button>
            </form>
            {requestedRepository&&<p>Workspace rules are inherited by this repository. Disabled rules remain visible for management but do not run in reviews.</p>}
            {isAdmin && (
              <section>
                <h2>Add a review rule</h2>
                <form action={saveRule} className="form-grid">
                  <input
                    type="hidden"
                    name="organizationId"
                    value={organization._id}
                  />
                  <label>
                    Title
                    <input name="title" required />
                  </label>
                  <RuleScopeFields teams={scopes.teams} repositories={data.repositories} scope={requestedRepository ? "repo:" + requestedRepository : ""} />
                  <label className="wide">
                    Instructions
                    <textarea name="instructions" rows={3} required />
                  </label>
                  <label>
                    Severity
                    <select name="severity">
                      <option>medium</option>
                      <option>high</option>
                      <option>critical</option>
                      <option>low</option>
                    </select>
                  </label>
                  <label>
                    File globs (comma separated)
                    <input name="globs" />
                  </label>
                  <button className="primary">Create rule</button>
                </form>
              </section>
            )}
            {isAdmin && <RuleAssistant ctx={ctx} />}
            {!visibleRules.length && (
              <Empty
                title="Your codebase, your conventions"
                text="Add specific rules such as requiring organization membership validation in API endpoints."
              />
            )}
            {visibleRules.map((r) => (
              <section key={r._id}>
                <h2>
                  {r.title} {status(r.enabled ? "enabled" : "disabled")}
                </h2>
                <p>{r.instructions}</p>
                <p className="muted">
                  {r.repositoryId ? repoName(r.repositoryId) : r.repositoryPattern ? <>Repositories matching <code>{r.repositoryPattern}</code></> : r.teamId ? `Team: ${scopes.teams.find((t) => t._id === r.teamId)?.name ?? "team"}` : "Workspace"} ·{" "}
                  {r.severity}
                  {!r.repositoryId&&<span className="badge">{requestedRepository?(r.repositoryPattern||r.teamId?"Inherited from a shared scope":"Inherited from workspace"):(r.repositoryPattern?"Repository pattern":r.teamId?"Team rule":"Workspace default")}</span>}
                </p>
                {isAdmin && (
                  <details>
                    <summary>Edit rule</summary>
                    <form action={saveRule} className="form-grid" key={JSON.stringify(r)}>
                      <input
                        type="hidden"
                        name="organizationId"
                        value={organization._id}
                      />
                      <input type="hidden" name="id" value={r._id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={String(r.enabled)}
                      />
                      <label>
                        Title
                        <input name="title" required defaultValue={r.title} />
                      </label>
                      <RuleScopeFields teams={scopes.teams} repositories={data.repositories} scope={scopeValue(r)} pattern={r.repositoryPattern} />
                      <label className="wide">
                        Instructions
                        <textarea
                          name="instructions"
                          required
                          defaultValue={r.instructions}
                        />
                      </label>
                      <label>
                        Severity
                        <select name="severity" defaultValue={r.severity}>
                          {["critical", "high", "medium", "low"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Globs
                        <input name="globs" defaultValue={r.globs.join(",")} />
                      </label>
                      <input type="hidden" name="category" value={r.category} />
                      <button>Save rule</button>
                    </form>
                  </details>
                )}
                {isAdmin && (
                  <form action={saveRule}>
                    <input
                      type="hidden"
                      name="organizationId"
                      value={organization._id}
                    />
                    <input type="hidden" name="id" value={r._id} />
                    <input type="hidden" name="title" value={r.title} />
                    <input
                      type="hidden"
                      name="instructions"
                      value={r.instructions}
                    />
                    <input type="hidden" name="severity" value={r.severity} />
                    <input type="hidden" name="scope" value={scopeValue(r)} />
                    <input type="hidden" name="repositoryPattern" value={r.repositoryPattern ?? ""} />
                    <input
                      type="hidden"
                      name="globs"
                      value={r.globs.join(",")}
                    />
                    <input type="hidden" name="category" value={r.category} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={String(!r.enabled)}
                    />
                    <button>
                      {r.enabled ? "Disable rule" : "Enable rule"}
                    </button>
                    <button name="remove" value="true">
                      Delete rule
                    </button>
                  </form>
                )}
              </section>
            ))}
            {rulesPage&&<nav className="toolbar" aria-label="Rules pagination">
              {filters.cursor&&<Link href={`/dashboard/memory/rules?${new URLSearchParams({...requestedRepository?{repository:requestedRepository}:{},...selectedTeam?{team:selectedTeam._id}:{}})}`}>Newest rules</Link>}
              {!rulesPage.isDone&&<Link href={`/dashboard/memory/rules?${new URLSearchParams({cursor:rulesPage.continueCursor,...requestedRepository?{repository:requestedRepository}:{},...selectedTeam?{team:selectedTeam._id}:{}})}`}>Older rules</Link>}
              <p className="muted">{visibleRules.length} rules on this page{rulesPage.isDone?" · End of rules":""}.</p>
            </nav>}
          </>
        )
  );
}

const scopeValue = (r: { repositoryId?: string; teamId?: string; repositoryPattern?: string }) => r.repositoryId ? "repo:" + r.repositoryId : r.teamId ? "team:" + r.teamId : r.repositoryPattern ? "pattern" : "";
// Scope picker: workspace, a team, a repository-name pattern or one repository. A more specific rule
// with the same title replaces a broader one for the repositories it covers.
function RuleScopeFields({ teams, repositories, scope, pattern }: { teams: { _id: string; name: string }[]; repositories: (NonNullable<Parameters<typeof repositoryDisplay>[0]> & { _id: string })[]; scope: string; pattern?: string }) {
  return <>
    <label>
      Scope
      <select name="scope" defaultValue={scope}>
        <option value="">Entire workspace</option>
        {teams.map((t) => <option key={t._id} value={"team:" + t._id}>Team: {t.name}</option>)}
        <option value="pattern">Repositories matching a pattern</option>
        {repositories.map((r) => <option key={r._id} value={"repo:" + r._id}>{repositoryDisplay(r)}</option>)}
      </select>
    </label>
    <label>
      Repository pattern (for pattern scope)
      <input name="repositoryPattern" defaultValue={pattern ?? ""} placeholder="acme/*-service" maxLength={200} />
    </label>
  </>;
}

const assistantKinds: Record<string, string> = { draft: "Drafted rule", refine: "Tighter wording", suggest: "Suggested rule", flag: "Rule overlap", import: "Imported rule" };
const runKinds: Record<string, string> = { draft: "Draft", refine: "Review of existing rules", suggest: "Suggestions from fixed findings and conventions", import: "Import from AI rule files" };
// AI rule assistant: every result is a suggestion an admin approves (optionally after editing) or dismisses.
function RuleAssistant({ ctx }: { ctx: DashboardContext }) {
  const { ruleAssistant, organization, scopes, data, repoName } = ctx;
  if (!ruleAssistant) return null;
  const busy = ruleAssistant.runs.some((r) => r.status === "pending");
  const scopeLabel = (s: { repositoryId?: string; teamId?: string; repositoryPattern?: string }) => s.repositoryId ? repoName(s.repositoryId) : s.repositoryPattern ? `Repositories matching ${s.repositoryPattern}` : s.teamId ? `Team: ${scopes.teams.find((t) => t._id === s.teamId)?.name ?? "team"}` : "Workspace";
  return (
    <section aria-labelledby="rule-assistant">
      <h2 id="rule-assistant">Rule assistant</h2>
      <p className="muted">Draft a rule from a description, tighten the wording of existing rules and find overlaps, or get suggestions from findings your team fixed on several pull requests and from approved conventions. Nothing changes until an admin approves a suggestion, and results that would suppress findings, approve changes or alter budgets are discarded.</p>
      <form action={requestRuleAssistant} className="form-grid">
        <input type="hidden" name="organizationId" value={organization._id} />
        <input type="hidden" name="kind" value="draft" />
        <label className="wide">
          Describe the rule
          <textarea name="description" rows={2} required minLength={10} maxLength={2000} placeholder="Payment code keeps amounts in integer cents, never floating-point dollars." />
        </label>
        <RuleScopeFields teams={scopes.teams} repositories={data.repositories} scope={ctx.requestedRepository ? "repo:" + ctx.requestedRepository : ""} />
        <button className="primary" disabled={busy}>Draft rule</button>
      </form>
      <form action={requestRuleAssistant} className="toolbar">
        <input type="hidden" name="organizationId" value={organization._id} />
        <button name="kind" value="refine" disabled={busy}>Review existing rules</button>
        <button name="kind" value="suggest" disabled={busy}>Suggest rules from fixed findings and conventions</button>
      </form>
      {ruleAssistant.runs.length > 0 && (
        <ul className="muted" aria-label="Recent rule assistant runs">
          {ruleAssistant.runs.slice(0, 5).map((r) => (
            <li key={r._id}>
              {runKinds[r.kind] ?? r.kind} · {r.status === "pending" ? "working…" : r.status === "failed" ? r.error ?? "failed" : `${r.suggestions ?? 0} suggestion${r.suggestions === 1 ? "" : "s"}`}
              {(r.rejected ?? []).map((x, i) => <span key={i}> · discarded “{x.title}” ({x.reason})</span>)}
            </li>
          ))}
        </ul>
      )}
      {ruleAssistant.suggestions.map((s) => (
        <article key={s._id} aria-label={`${assistantKinds[s.kind] ?? s.kind}: ${s.title}`}>
          <h3>{assistantKinds[s.kind] ?? s.kind}: {s.title}</h3>
          {s.kind === "refine" && s.base && <p className="muted">Currently: <strong>{s.base.title}</strong>: {s.base.instructions}</p>}
          <p>{s.instructions}</p>
          {s.kind !== "flag" && <p className="muted">{scopeLabel(s)} · {s.category} · {s.severity}{s.globs.length ? " · " + s.globs.join(", ") : ""}</p>}
          <p>{s.rationale}</p>
          {s.issues.length > 0 && <ul>{s.issues.map((i, n) => <li key={n}><span className="badge">{i.kind}</span> {i.detail}</li>)}</ul>}
          <p className="muted">Based on: {s.sources.map((x, n) => <span key={n}>{n ? "; " : ""}{x.kind === "description" ? "your description" : x.kind === "rule" ? `rule “${x.label}”` : x.kind === "file" ? <code>{x.label}</code> : `“${x.label}”`}{x.detail ? ` (${x.detail})` : ""}</span>)}</p>
          <form action={decideRuleSuggestion} className="form-grid">
            <input type="hidden" name="suggestionId" value={s._id} />
            {s.kind !== "flag" && (
              <>
                <label>
                  Title
                  <input name="title" required defaultValue={s.title} maxLength={120} />
                </label>
                <label>
                  Severity
                  <select name="severity" defaultValue={s.severity}>
                    {["critical", "high", "medium", "low"].map((v) => <option key={v}>{v}</option>)}
                  </select>
                </label>
                <label className="wide">
                  Instructions
                  <textarea name="instructions" required defaultValue={s.instructions} rows={3} />
                </label>
              </>
            )}
            <button className="primary" name="decision" value="approved">{s.kind === "flag" ? "Disable the newer rule" : s.kind === "refine" ? "Apply to rule" : "Approve rule"}</button>
            <button name="decision" value="rejected" formNoValidate>Dismiss</button>
          </form>
        </article>
      ))}
    </section>
  );
}
