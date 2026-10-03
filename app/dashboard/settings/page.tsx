import type { Metadata } from "next";
import Link from "next/link";
import { SourceBadge } from "@/components/dashboard/SettingsFields";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { resolveEffectiveSettings, type SettingKey } from "@/lib/config/settings";
import { db } from "@/lib/db";
import { getOrgSettings } from "@/lib/data/settings";
import { siteEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Settings" };

const LABELS: Record<SettingKey, string> = {
  autoReview: "Automatic review",
  reviewDrafts: "Review drafts",
  autoReReview: "Re-review on new commits",
  targetBranches: "Target branches",
  ignoredBranches: "Ignored branches",
  ignore: "Ignored paths",
  maxComments: "Max comments",
  minConfidence: "Minimum confidence",
  minSeverity: "Minimum severity",
  categories: "Categories",
  model: "Model",
  mode: "Review mode",
  customInstructions: "Custom instructions",
  commentStyle: "Comment style",
  strictness: "Strictness",
  context: "Context files",
};

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "All";
  return String(v);
}

export default async function SettingsPage() {
  const { orgId, orgName, role } = await requireOrg();
  const org = await getOrgSettings(db(), orgId);
  const { settings, sources } = resolveEffectiveSettings(org, undefined, undefined);
  const docs = `${siteEnv().SOURCE_CODE_URL}/blob/main/docs/OPENREVIEW_SPEC.md`;
  return (
    <>
      <PageHeader title="Settings" description={`Organization-wide settings for ${orgName}.`} />
      <EmptyState
        icon="settings"
        title="Review behavior is set per repository today"
        headingLevel={2}
        actions={
          <>
            <ButtonLink href="/dashboard/repos">Repository settings</ButtonLink>
            {can(role, "apikeys.manage") && <ButtonLink href="/dashboard/settings/api-keys">API keys</ButtonLink>}
            <ButtonLink href={docs} external variant="ghost">
              Settings reference
            </ButtonLink>
          </>
        }
      >
        <p>
          Here you&apos;ll edit review defaults for every repository, model providers and keys, single sign-on, API keys, and billing. Today,
          change review behavior per repository from its <strong>Settings</strong> tab, or with an <code>openreview.json</code> in the
          repository.
        </p>
      </EmptyState>
      <Card title="Current review defaults" titleId="defaults-heading" description="Repositories inherit these unless they set their own">
        <dl className="kv">
          {(Object.keys(LABELS) as SettingKey[]).map((k) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{LABELS[k]}</dt>
              <dd className="row-tight">
                <span className="break">{show(settings[k])}</span> <SourceBadge source={sources[k]} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="dim">
          Members and roles are on the <Link href="/dashboard/team">Team</Link> page.
        </p>
      </Card>
    </>
  );
}
