import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RuleForm } from "@/components/rules/RuleForm";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { repoOptions } from "@/lib/data/repos";
import { getRule, ruleFindingCounts } from "@/lib/data/rules";
import { ruleDisplayTitle } from "@/lib/rules/catalog";
import { removeRule, reviewCandidate, saveRule } from "../actions";

export const metadata: Metadata = { title: "Edit rule" };

/** Edit one rule (R6.11), approve it if it's a suggestion (R2.5), see its findings, or delete it. */
export default async function EditRulePage({ params }: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg({ permission: "rules.manage" });
  const id = Number((await params).id);
  const rule = Number.isSafeInteger(id) && id > 0 ? await getRule(db(), orgId, id) : undefined;
  if (!rule) notFound();
  const [repos, counts] = await Promise.all([repoOptions(db(), orgId), ruleFindingCounts(db(), orgId, [rule.id])]);
  const findings = counts.get(rule.id) ?? 0;
  const title = ruleDisplayTitle(rule);
  return (
    <>
      <PageHeader
        title={title}
        breadcrumbs={[{ label: "Rules", href: "/dashboard/rules" }, { label: `rule:${rule.id}` }]}
        meta={
          <Link href={`/dashboard/findings?rule=${encodeURIComponent(`rule:${rule.id}`)}`}>
            {findings} finding{findings === 1 ? "" : "s"} from this rule
          </Link>
        }
      />
      {rule.status === "candidate" && (
        <Alert tone="info" title="Suggested from your reviewers">
          <p>This rule takes effect once approved. Edit it below if needed, then approve it.</p>
          <form action={reviewCandidate}>
            <input type="hidden" name="ruleId" value={rule.id} />
            <input type="hidden" name="decision" value="approve" />
            <SubmitButton size="sm" variant="primary" icon="check">
              Approve
            </SubmitButton>
          </form>
        </Alert>
      )}
      {rule.evidence && rule.evidence.length > 0 && (
        <Card title="Evidence" titleId="evidence-heading" description="The review comments this rule was mined from.">
          <ul className="dim">
            {rule.evidence.map((e) => (
              <li key={e.commentId}>
                @{e.author}: “{e.excerpt}”
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <RuleForm
          initial={{
            ruleId: rule.id,
            title: rule.title || title,
            text: rule.text,
            category: rule.category,
            severity: rule.severity,
            enabled: rule.enabled,
            instructions: rule.instructions,
            paths: rule.paths,
            repoId: rule.repoId,
          }}
          repos={repos}
          action={saveRule}
          submitLabel="Save rule"
        />
      </Card>
      <Card title="Delete rule" titleId="delete-rule-heading" description="Findings that cited it keep the citation.">
        <form action={removeRule}>
          <input type="hidden" name="ruleId" value={rule.id} />
          <ConfirmButton prompt="Delete this rule?" confirmLabel="Delete">
            Delete rule
          </ConfirmButton>
        </form>
      </Card>
    </>
  );
}
