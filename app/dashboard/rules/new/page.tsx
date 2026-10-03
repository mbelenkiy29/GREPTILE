import type { Metadata } from "next";
import { EMPTY_RULE, RuleForm } from "@/components/rules/RuleForm";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOrg } from "@/lib/auth";
import { db } from "@/lib/db";
import { repoOptions } from "@/lib/data/repos";
import { RULE_TEMPLATES } from "@/lib/rules/catalog";
import { param, type SearchParams } from "@/lib/ui/url";
import { saveRule } from "../actions";

export const metadata: Metadata = { title: "New rule" };

/** Create a rule (R6.11); `?template=<id>` starts from a starter template. */
export default async function NewRulePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { orgId } = await requireOrg({ permission: "rules.manage" });
  const [repos, sp] = await Promise.all([repoOptions(db(), orgId), searchParams]);
  const templateId = param(sp, "template");
  const t = RULE_TEMPLATES.find((x) => x.id === templateId);
  const initial = t
    ? { ...EMPTY_RULE, title: t.title, text: t.text, category: t.category, severity: t.severity, instructions: t.instructions, paths: [...t.paths] }
    : EMPTY_RULE;
  return (
    <>
      <PageHeader title="New rule" breadcrumbs={[{ label: "Rules", href: "/dashboard/rules" }, { label: "New rule" }]} />
      <Card>
        <RuleForm initial={initial} repos={repos} action={saveRule} submitLabel="Create rule" />
      </Card>
    </>
  );
}
