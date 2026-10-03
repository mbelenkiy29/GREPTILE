import type { Metadata } from "next";
import { LearnedList } from "@/components/dashboard/LearnedList";
import { RulesNav } from "@/components/dashboard/RulesNav";
import { humanize } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { feedbackSummary } from "@/lib/data/feedback";
import { listPreferences } from "@/lib/learning/preferences";
import { formatPercent } from "@/lib/ui/format";
import { editPattern, removePattern, resetAllPreferences } from "./actions";

export const metadata: Metadata = { title: "Preferences" };

/** Learned preferences (R2.4, R6.10): what reviews learned from feedback, editable, resettable, and exportable. */
export default async function LearnedPage() {
  const { orgId, role } = await requireOrg();
  const manage = can(role, "rules.manage");
  const [prefs, summary] = await Promise.all([listPreferences(db(), orgId), feedbackSummary(db(), orgId)]);
  const items = prefs.map((p) => ({ ...p, userEdited: p.pinned }));
  return (
    <>
      <PageHeader
        title="Preferences"
        description="What reviews have learned from your team's feedback."
        actions={
          <ButtonLink href="/api/orgs/current/preferences/export" icon="copy" download>
            Export JSON
          </ButtonLink>
        }
      />
      <RulesNav current="learned" />
      <p className="dim">
        Learned from reactions, replies, commands, and dashboard feedback on findings. Suppressed preferences stop similar findings; prioritized ones
        rank higher; a suppressed category raises the confidence its findings need. Editing a preference pins it, so later feedback and resets leave it
        alone.
        {!manage && " Only owners and admins can change them."}
      </p>

      <Card title="Acceptance by category" titleId="acceptance-heading" description="How your team rated findings, per category." flush>
        {summary.byCategory.length ? (
          <Table caption="Feedback by category" captionHidden compact>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col" className="num">
                  Useful
                </th>
                <th scope="col" className="num">
                  Not useful
                </th>
                <th scope="col" className="num">
                  False positive
                </th>
                <th scope="col" className="num">
                  Resolved
                </th>
                <th scope="col" className="num">
                  Won&apos;t fix
                </th>
                <th scope="col" className="num">
                  Acceptance
                </th>
              </tr>
            </thead>
            <tbody>
              {summary.byCategory.map((c) => (
                <tr key={c.category} data-category={c.category}>
                  <td>{humanize(c.category)}</td>
                  <td className="num">{c.useful}</td>
                  <td className="num">{c.notUseful}</td>
                  <td className="num">{c.falsePositive}</td>
                  <td className="num">{c.resolved}</td>
                  <td className="num">{c.wontFix}</td>
                  <td className="num">{c.acceptanceRate === null ? "—" : formatPercent(c.acceptanceRate)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="card-body dim">No feedback yet. Mark findings useful or not useful on the Findings page, or react to review comments on GitHub.</p>
        )}
      </Card>

      <section className="stack-sm" aria-labelledby="prefs-heading">
        <div className="page-head">
          <h2 id="prefs-heading">Learned preferences ({items.length})</h2>
          {manage && items.length > 0 && (
            <form action={resetAllPreferences} className="row-tight" data-testid="reset-preferences">
              <label className="check">
                <input type="checkbox" name="includePinned" /> <span>Include pinned</span>
              </label>
              <ConfirmButton prompt="Forget learned preferences?" confirmLabel="Reset">
                Reset all
              </ConfirmButton>
            </form>
          )}
        </div>
        <LearnedList
          items={items}
          actions={
            manage
              ? (i) => (
                  <>
                    <details className="disclosure">
                      <summary>Edit</summary>
                      <form action={editPattern} className="disclosure-body stack-sm">
                        <input type="hidden" name="id" value={i.id} />
                        <div className="field">
                          <label className="field-label" htmlFor={`pref-${i.id}-desc`}>
                            Description
                          </label>
                          <input id={`pref-${i.id}-desc`} name="description" className="input" defaultValue={i.description} minLength={3} required />
                        </div>
                        <div className="field">
                          <label className="field-label" htmlFor={`pref-${i.id}-signal`}>
                            Signal
                          </label>
                          <select id={`pref-${i.id}-signal`} name="signal" className="select" defaultValue={i.signal}>
                            <option value="suppress">Suppress</option>
                            <option value="boost">Prioritize</option>
                            <option value="neutral">Observe</option>
                          </select>
                        </div>
                        <div>
                          <SubmitButton size="sm" variant="primary">
                            Save and pin
                          </SubmitButton>
                        </div>
                      </form>
                    </details>
                    <form action={removePattern}>
                      <input type="hidden" name="id" value={i.id} />
                      <ConfirmButton prompt="Delete this preference?" confirmLabel="Delete">
                        Delete
                      </ConfirmButton>
                    </form>
                  </>
                )
              : undefined
          }
        />
      </section>
    </>
  );
}
