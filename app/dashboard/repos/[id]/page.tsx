import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { COMMENT_TYPES, CONFIG_FILE, DEFAULTS, STRICTNESS } from "@/lib/config/repo-config";
import { db } from "@/lib/db";
import { getRepo } from "@/lib/data/installations";
import { saveRepoSettings } from "../actions";

export default async function RepoSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { orgId } = await requireOrg();
  const repo = await getRepo(db(), orgId, Number((await params).id));
  if (!repo) notFound();
  const s = repo.settings;
  return (
    <div className="stack">
      <Link href="/dashboard/repos" className="dim">
        ← Repositories
      </Link>
      <h1>{repo.fullName} settings</h1>
      <p className="dim">
        A <code>{CONFIG_FILE}</code> on the default branch overrides these settings key by key.
      </p>
      <form action={saveRepoSettings} className="comment stack-sm">
        <input type="hidden" name="repoId" value={repo.id} />
        <label>
          Strictness{" "}
          <select name="strictness" defaultValue={s.strictness ?? DEFAULTS.strictness}>
            {STRICTNESS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="row">
          <legend>Comment types</legend>
          {COMMENT_TYPES.map((t) => (
            <label key={t}>
              <input type="checkbox" name="commentTypes" value={t} defaultChecked={(s.commentTypes ?? DEFAULTS.commentTypes).includes(t)} /> {t}
            </label>
          ))}
        </fieldset>
        <label className="stack-sm">
          Ignore paths (globs, one per line)
          <textarea name="ignore" rows={3} defaultValue={(s.ignore ?? []).join("\n")} placeholder="**/generated/**" />
        </label>
        <label className="stack-sm">
          Context files always included in reviews (paths or globs, one per line)
          <textarea name="context" rows={3} defaultValue={(s.context ?? []).join("\n")} placeholder={"CONTRIBUTING.md\ndocs/adr/*.md"} />
        </label>
        <div>
          <button className="button button-primary" type="submit">Save settings</button>
        </div>
      </form>
    </div>
  );
}
