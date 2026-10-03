import type { Metadata } from "next";
import Link from "next/link";
import { OrgSettingsForm } from "@/components/dashboard/OrgSettingsForm";
import { Card } from "@/components/ui/Card";
import { Table } from "@/components/ui/Table";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/auth/permissions";
import { resolveEffectiveSettings, SETTING_DEFAULTS, type SettingKey } from "@/lib/config/settings";
import { db } from "@/lib/db";
import { listRepos } from "@/lib/data/installations";
import { getOrgSettings } from "@/lib/data/settings";
import { saveOrgDefaults } from "../actions";

export const metadata: Metadata = { title: "Review defaults" };

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

function overriddenKeys(settings: Record<string, unknown>): string[] {
  return Object.keys(settings)
    .filter((k) => settings[k] !== undefined)
    .map((k) => (Object.hasOwn(LABELS, k) ? LABELS[k as SettingKey] : k === "commentTypes" ? LABELS.categories : k));
}

/** Settings → Review defaults: the org-wide layer every repository inherits (R6.14), and which repositories override it. */
export default async function ReviewDefaultsPage() {
  const { orgId, role } = await requireOrg();
  const [org, repos] = await Promise.all([getOrgSettings(db(), orgId), listRepos(db(), orgId)]);
  const orgSettings = org ?? {};
  const { settings, sources } = resolveEffectiveSettings(orgSettings, undefined, undefined);
  const overriding = repos.map((r) => ({ id: r.id, fullName: r.fullName, keys: [...new Set(overriddenKeys(r.settings as Record<string, unknown>))] }));
  return (
    <>
      <p className="dim">
        Defaults for every repository in this organization. A repository&apos;s own settings (its Settings tab) override these, and its{" "}
        <code>openreview.json</code> overrides both, key by key.
        {!can(role, "settings.manage") && " Only owners and admins can change them."}
      </p>
      <Card>
        <OrgSettingsForm
          editable={can(role, "settings.manage")}
          action={saveOrgDefaults}
          settings={settings}
          sources={sources}
          inherited={SETTING_DEFAULTS}
          repoSettings={orgSettings}
        />
      </Card>
      <Card title="What repositories inherit" titleId="inherit-heading" description="Repositories use these defaults except for the settings listed next to them." flush>
        {overriding.length ? (
          <Table caption="Repository overrides" captionHidden compact>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Overrides</th>
              </tr>
            </thead>
            <tbody>
              {overriding.map((r) => (
                <tr key={r.id} data-repo={r.fullName}>
                  <td>
                    <Link href={`/dashboard/repos/${r.id}?tab=settings`}>{r.fullName}</Link>
                  </td>
                  <td className={r.keys.length ? undefined : "dim"}>{r.keys.length ? r.keys.join(", ") : "Inherits every default"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="card-body dim">No repositories are connected yet.</p>
        )}
      </Card>
    </>
  );
}
