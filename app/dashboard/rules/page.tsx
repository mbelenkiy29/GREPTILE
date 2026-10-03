import type { Metadata } from "next";
import { RulesNav } from "@/components/dashboard/RulesNav";
import { RuleCard, type RuleCardItem } from "@/components/rules/RuleCard";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { repoOptions } from "@/lib/data/repos";
import { listRules, ruleFindingCounts, type RuleListFilter } from "@/lib/data/rules";
import { getRepoConfigRules } from "@/lib/data/settings";
import { gitHost } from "@/lib/git/host";
import type { GitHost } from "@/lib/git/types";
import { RULE_CATEGORIES, RULE_CATEGORY_LABEL, RULE_TEMPLATES } from "@/lib/rules/catalog";
import { enumParam, hrefWith, intParam, queryState, type SearchParams } from "@/lib/ui/url";
import { addTemplate, removeRule, reviewCandidate, toggleRule } from "./actions";

export const metadata: Metadata = { title: "Rules" };

const PATH = "/dashboard/rules";
const STATUSES = ["active", "candidate", "rejected"] as const;
const STATUS_LABEL = { active: "Active", candidate: "Suggested", rejected: "Dismissed" } as const;

/** The configured GitHub host, or undefined when the GitHub App isn't configured (the page still renders). */
function optionalHost(): GitHost | undefined {
  try {
    return gitHost();
  } catch {
    return undefined;
  }
}

function toItem(r: Awaited<ReturnType<typeof listRules>>[number], findings: Map<number, number>): RuleCardItem {
  return { ...r.rule, repoFullName: r.repoFullName, findings: findings.get(r.rule.id) ?? 0 };
}

function FilterSelect({ id, name, label, value, options, any }: { id: string; name: string; label: string; value: string; options: { value: string; label: string }[]; any: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select id={id} name={name} className="select" defaultValue={value}>
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Rules (R2.1, R2.5, R6.11): filters, the rule list with controls, suggested rules, templates, and openreview.json rules. */
export default async function RulesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId, role } = await requireOrg();
  const manage = can(role, "rules.manage");
  const sp = await searchParams;
  const state = queryState(sp);
  const status = enumParam(sp, "status", STATUSES) ?? "active";
  const enabledParam = enumParam(sp, "enabled", ["on", "off"] as const);
  const filter: RuleListFilter = {
    status: [status],
    repoId: intParam(sp, "repo"),
    scope: enumParam(sp, "scope", ["org", "repo"] as const),
    category: enumParam(sp, "category", RULE_CATEGORIES),
    enabled: enabledParam === undefined ? undefined : enabledParam === "on",
  };
  const filtered = ["repo", "scope", "category", "enabled", "status"].some((k) => state[k]);
  const [rows, candidates, all, repos] = await Promise.all([
    listRules(db(), orgId, filter),
    status === "active" ? listRules(db(), orgId, { status: ["candidate"] }) : Promise.resolve([]),
    listRules(db(), orgId),
    repoOptions(db(), orgId),
  ]);
  const counts = await ruleFindingCounts(db(), orgId, [...rows, ...candidates].map((r) => r.rule.id));
  const host = filter.repoId ? optionalHost() : undefined;
  const config = filter.repoId && host ? await getRepoConfigRules(db(), orgId, filter.repoId, { host }) : undefined;
  const returnTo = hrefWith(PATH, state);
  const usedTitles = new Set(all.map((r) => r.rule.title.toLowerCase()));

  return (
    <>
      <PageHeader
        title="Rules"
        description="Plain-English rules your reviews enforce. Each finding that enforces a rule cites it."
        actions={
          manage ? (
            <ButtonLink href={`${PATH}/new`} variant="primary" icon="plus">
              New rule
            </ButtonLink>
          ) : undefined
        }
      />
      <RulesNav current="rules" />
      {!manage && <p className="dim">Only owners and admins can change rules.</p>}

      {candidates.length > 0 && (
        <section className="stack-sm" aria-labelledby="suggested-heading">
          <h2 id="suggested-heading">Suggested from your reviewers ({candidates.length})</h2>
          <p className="dim">Mined from comments your teammates left on pull requests. They take effect only once approved.</p>
          {candidates.map((r) => (
            <RuleCard
              key={r.rule.id}
              rule={toItem(r, counts)}
              actions={
                manage ? (
                  <>
                    <form action={reviewCandidate}>
                      <input type="hidden" name="ruleId" value={r.rule.id} />
                      <input type="hidden" name="decision" value="approve" />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <SubmitButton size="sm" variant="primary" icon="check">
                        Approve
                      </SubmitButton>
                    </form>
                    <ButtonLink href={`${PATH}/${r.rule.id}`} size="sm">
                      Edit first
                    </ButtonLink>
                    <form action={reviewCandidate}>
                      <input type="hidden" name="ruleId" value={r.rule.id} />
                      <input type="hidden" name="decision" value="reject" />
                      <input type="hidden" name="returnTo" value={returnTo} />
                      <SubmitButton size="sm" variant="ghost">
                        Dismiss
                      </SubmitButton>
                    </form>
                  </>
                ) : undefined
              }
            />
          ))}
        </section>
      )}

      <form className="filter-bar" action={PATH} aria-label="Filter rules" data-testid="rules-filters">
        <FilterSelect id="rf-status" name="status" label="Status" value={state.status ?? ""} any="Active" options={STATUSES.filter((s) => s !== "active").map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
        <FilterSelect id="rf-scope" name="scope" label="Scope" value={state.scope ?? ""} any="Any scope" options={[{ value: "org", label: "Organization-wide" }, { value: "repo", label: "One repository" }]} />
        <FilterSelect id="rf-repo" name="repo" label="Repository" value={state.repo ?? ""} any="All repositories" options={repos.map((r) => ({ value: String(r.id), label: r.fullName }))} />
        <FilterSelect id="rf-category" name="category" label="Category" value={state.category ?? ""} any="Any category" options={RULE_CATEGORIES.map((c) => ({ value: c, label: RULE_CATEGORY_LABEL[c] }))} />
        <FilterSelect id="rf-enabled" name="enabled" label="State" value={state.enabled ?? ""} any="On or off" options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} />
        <div className="filter-bar-actions">
          <button className="button" type="submit">
            Apply
          </button>
          {filtered && (
            <ButtonLink href={PATH} variant="ghost">
              Reset
            </ButtonLink>
          )}
        </div>
      </form>

      <section className="stack-sm" aria-labelledby="rules-heading">
        <h2 id="rules-heading">
          {STATUS_LABEL[status]} rules ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <EmptyState
            icon="rules"
            title={filtered ? "No rules match these filters" : "No rules yet"}
            headingLevel={3}
            actions={filtered ? <ButtonLink href={PATH}>Reset filters</ButtonLink> : manage ? <ButtonLink href={`${PATH}/new`} variant="primary">Write a rule</ButtonLink> : undefined}
          >
            {!filtered && <p>Rules capture what your team cares about in review. Start from a template below or write your own.</p>}
          </EmptyState>
        ) : (
          rows.map((r) => (
            <RuleCard
              key={r.rule.id}
              rule={toItem(r, counts)}
              actions={
                manage ? (
                  <>
                    {r.rule.status === "active" && (
                      <form action={toggleRule}>
                        <input type="hidden" name="ruleId" value={r.rule.id} />
                        <input type="hidden" name="enabled" value={r.rule.enabled ? "false" : "true"} />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <SubmitButton size="sm" icon={r.rule.enabled ? "pause" : "play"}>
                          {r.rule.enabled ? "Turn off" : "Turn on"}
                        </SubmitButton>
                      </form>
                    )}
                    {r.rule.status === "rejected" && (
                      <form action={reviewCandidate}>
                        <input type="hidden" name="ruleId" value={r.rule.id} />
                        <input type="hidden" name="decision" value="approve" />
                        <input type="hidden" name="returnTo" value={returnTo} />
                        <SubmitButton size="sm">Approve</SubmitButton>
                      </form>
                    )}
                    <ButtonLink href={`${PATH}/${r.rule.id}`} size="sm">
                      Edit
                    </ButtonLink>
                    <form action={removeRule}>
                      <input type="hidden" name="ruleId" value={r.rule.id} />
                      <ConfirmButton prompt="Delete this rule?" confirmLabel="Delete">
                        Delete
                      </ConfirmButton>
                    </form>
                  </>
                ) : undefined
              }
            />
          ))
        )}
      </section>

      {filter.repoId !== undefined && (
        <Card title="From repository config" titleId="config-rules" description="Rules in the repository's openreview.json on its default branch. Edit them in the repository.">
          {!config ? (
            <p className="dim">The GitHub App isn&apos;t configured on this server, so openreview.json can&apos;t be read.</p>
          ) : config.status === "found" && config.rules.length ? (
            <ul className="comments">
              {config.rules.map((r) => (
                <li key={r.id} className="comment" data-config-rule={r.id}>
                  <div className="row-tight">
                    <Badge tone="warn">from repository config</Badge>
                    <span className="mono dim">{r.id}</span>
                    {r.paths.length > 0 ? <span className="mono dim break">{r.paths.join(", ")}</span> : <span className="dim">all files</span>}
                  </div>
                  <p>{r.text}</p>
                </li>
              ))}
            </ul>
          ) : config.status === "found" || config.status === "absent" ? (
            <p className="dim">{config.fullName} has no rules in openreview.json.</p>
          ) : (
            <Alert tone="warning">{config.message}</Alert>
          )}
        </Card>
      )}
      {filter.repoId === undefined && <p className="dim">Pick a repository in the filters to also see the rules in its openreview.json.</p>}

      {manage && (
        <Card title="Starter templates" titleId="templates-heading" description="Common rules to start from. Each is added organization-wide; edit it afterwards to fit your code.">
          <ul className="comments">
            {RULE_TEMPLATES.map((t) => (
              <li key={t.id} className="comment" data-template={t.id}>
                <div className="rule-card-head">
                  <span className="strong">{t.title}</span>
                  <span className="spacer" />
                  <Badge tone="outline">{RULE_CATEGORY_LABEL[t.category]}</Badge>
                </div>
                <p className="dim">{t.text}</p>
                <div className="row">
                  {usedTitles.has(t.title.toLowerCase()) ? (
                    <Badge tone="ok">Added</Badge>
                  ) : (
                    <form action={addTemplate}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <SubmitButton size="sm" icon="plus">
                        Add rule
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
