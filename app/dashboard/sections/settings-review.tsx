import { repositoryDisplay } from "../../../src/provider-display";
import Link from "next/link";

import { lockableKeys } from "../../../src/review-settings";
import { saveSettings, revokeApiKey, decideConvention } from "../actions";
import { ApiKeyForm } from "../api-key";
import { SummarySettings } from "../summary-settings";

import type { DashboardContext } from "../load";

export function ReviewSettingsSection({ ctx }: { ctx: DashboardContext }) {
  const { apiKeys, conventions, data, filters, isAdmin, organization, repoLabel, repoSettings, requestedRepository, section, semantic } = ctx;
  return (
(
          <>
            {section[1] === "keys" && (isAdmin ? (
              <section>
                <h2>Developer API keys</h2>
                <ApiKeyForm organizationId={organization._id} />
                {apiKeys.map((k) => (
                  <form action={revokeApiKey} key={k._id}>
                    <p>
                      {k.name} · {k.prefix}… · {k.legacy ? "all scopes (created before scopes)" : k.scopes.join(", ")} ·{" "}
                      {k.revoked ? "Revoked" : "Active"}
                    </p>
                    <input type="hidden" name="keyId" value={k._id} />
                    {!k.revoked && <button>Revoke key</button>}
                  </form>
                ))}
              </section>
            ) : <p>Workspace admin access required.</p>)}
            {section[1] === "review" && <form method="get" className="filter-bar">{filters.team!==undefined&&<input type="hidden" name="team" value={filters.team}/>}<label>Repository<select name="repository" defaultValue={requestedRepository??""} required><option value="" disabled>Choose a repository</option>{data.repositories.map(r=><option key={r._id} value={r._id}>{repositoryDisplay(r)}</option>)}</select></label><button>View review settings</button></form>}
            {section[1] === "review" && !repoSettings && <p>Select a repository to inspect its effective review settings. <Link href="/dashboard/settings/teams">Manage workspace and team defaults</Link>.</p>}
            {repoSettings && (
              <section>
                <h2>{repoSettings.repo.fullName}</h2>
                <p className="muted repository-identity">{repoLabel(repoSettings.repo._id)}</p>
                <details className="effective-config"><summary>Effective configuration and sources</summary>
                  {repoSettings.repo.configFile ? <p>Repository config from base revision <code>{repoSettings.repo.configFile.sha.slice(0, 7)}</code>: {repoSettings.repo.configFile.files.map((f) => <code key={f}>{f} </code>)}{repoSettings.repo.configFile.rules ? ` · ${repoSettings.repo.configFile.rules} rules` : ""}</p> : <p className="muted">No <code>.openreview.json</code> or <code>.openreview/</code> configuration was found on a reviewed base branch yet.</p>}
                  {repoSettings.repo.configFile?.warnings.map((w) => <p key={w} className="warning" role="alert">{w}</p>)}
                  <table><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>{lockableKeys.map((key) => {
                    const fromFile = repoSettings.repo.configFile?.applied.includes(key), locked = repoSettings.repo.configFile?.blocked.includes(key);
                    const fileValues = fromFile ? JSON.parse(repoSettings.repo.configFile!.values) as Record<string, unknown> : {};
                    const value = fromFile ? fileValues[key] : (repoSettings.settings as Record<string, unknown>)[key];
                    return <tr key={key}><td>{key}</td><td><code>{JSON.stringify(value ?? null).slice(0, 120)}</code></td><td>{fromFile ? "repository file" : (repoSettings.provenance[key] ?? "default") + ((repoSettings.settings.lockedKeys ?? []).includes(key) ? " · locked" : "") + (locked ? " (file value ignored)" : "")}</td></tr>;
                  })}</tbody></table>
                </details>
                {semantic && <p className="muted" aria-label="Semantic retrieval status">{semantic.configured ? <>Semantic retrieval: <strong>on</strong> · {semantic.model} · {semantic.chunks}{semantic.more ? "+" : ""} chunks across {semantic.files} files{semantic.stale ? ` · ${semantic.stale} chunks from another model are replaced on the next re-index` : ""}{!semantic.chunks ? " · re-index to build chunk embeddings" : ""}</> : <>Semantic retrieval: <strong>off</strong>. Set <code>EMBEDDING_MODEL</code> (an OpenAI-compatible 1,536-dimension endpoint) in the backend environment and re-index; full-text and code-graph retrieval run either way.</>}</p>}
                <form action={saveSettings}><fieldset className="form-grid" disabled={!isAdmin}><legend>Repository review settings</legend>
                  <input
                    type="hidden"
                    name="repositoryId"
                    value={repoSettings.repo._id}
                  />
                  {(["automatic", "drafts", "rereview"] as const).map((key) => (
                    <label key={key}>
                      <span>
                        <input
                          type="checkbox"
                          name={key}
                          defaultChecked={repoSettings.settings[key]}
                        />{" "}
                        {key === "automatic"
                          ? "Automatic reviews (off: only on @openreview review or a trigger label)"
                          : key === "drafts"
                            ? "Review draft PRs"
                            : "Re-review new commits"}
                      </span>
                    </label>
                  ))}
                  {(
                    [
                      "targetBranches",
                      "ignoredBranches",
                      "ignoredPaths",
                    ] as const
                  ).map((key) => (
                    <label key={key}>
                      {key.replace(/([A-Z])/g, " $1")} (comma separated)
                      <input
                        name={key}
                        defaultValue={repoSettings.settings[key].join(", ")}
                      />
                    </label>
                  ))}
                  <label>
                    Maximum comments
                    <input
                      name="maxComments"
                      type="number"
                      min={0}
                      max={30}
                      defaultValue={repoSettings.settings.maxComments}
                    />
                  </label>
                  <label>
                    Minimum confidence
                    <input
                      name="minimumConfidence"
                      type="number"
                      min={0.5}
                      max={1}
                      step={0.01}
                      defaultValue={repoSettings.settings.minimumConfidence}
                    />
                  </label>
                  <label>
                    Severity threshold
                    <select
                      name="severityThreshold"
                      defaultValue={repoSettings.settings.severityThreshold}
                    >
                      {["critical", "high", "medium", "low"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Depth
                    <select
                      name="mode"
                      defaultValue={repoSettings.settings.mode}
                    >
                      {["fast", "standard", "deep"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Review engine
                    <select
                      name="reviewEngine"
                      defaultValue={repoSettings.settings.reviewEngine ?? "pipeline"}
                    >
                      <option value="pipeline">pipeline (specialists)</option>
                      <option value="agentic">agentic (tool-calling, experimental)</option>
                    </select>
                  </label>
                  <label>
                    Strictness
                    <select name="strictness" defaultValue={String(repoSettings.settings.strictness ?? 0)}>
                      <option value="0">custom thresholds</option>
                      <option value="1">1 · fewest, highest-confidence comments</option>
                      <option value="2">2 · balanced</option>
                      <option value="3">3 · most thorough</option>
                    </select>
                  </label>
                  <label>
                    Trigger labels
                    <input name="triggerLabels" placeholder="openreview, needs-review" defaultValue={(repoSettings.settings.triggerLabels ?? []).join(", ")} />
                  </label>
                  <label>
                    Excluded authors (globs)
                    <input name="excludedAuthors" placeholder="dependabot[bot], *-bot" defaultValue={(repoSettings.settings.excludedAuthors ?? []).join(", ")} />
                  </label>
                  <label>
                    Skip automatic reviews above changed files (0 = no limit)
                    <input name="maxFiles" type="number" min={0} defaultValue={repoSettings.settings.maxFiles ?? 0} />
                  </label>
                  <label>
                    Skip automatic reviews above changed lines (0 = no limit)
                    <input name="maxChangedLines" type="number" min={0} defaultValue={repoSettings.settings.maxChangedLines ?? 0} />
                  </label>
                  <fieldset className="wide">
                    <legend>Learned team conventions</legend>
                    <input type="hidden" name="conventionsConfigured" value="true" />
                    <label className="check"><input type="checkbox" name="autoApproveConventions" defaultChecked={repoSettings.settings.autoApproveConventions ?? false} /> Auto-approve conventions learned from human review comments (they only add review guidance)</label>
                  </fieldset>
                  <fieldset className="wide">
                    <legend>Fix pull requests</legend>
                    <input type="hidden" name="fixConfigured" value="true" />
                    <label className="check"><input type="checkbox" name="fixPullRequests" defaultChecked={repoSettings.settings.fixPullRequests ?? false} /> Allow “@openreview fix this in a new PR” to open a fix pull request on a new branch (GitHub, needs the Contents: Read and write permission; the pull request’s own branch is never written)</label>
                  </fieldset>
                  <fieldset className="wide">
                    <legend>Lock against the repository config file</legend>
                    <input type="hidden" name="lockedConfigured" value="true" />
                    {lockableKeys.map((key) => (
                      <label key={key} className="check"><input type="checkbox" name="lockedKeys" value={key} defaultChecked={(repoSettings.settings.lockedKeys ?? []).includes(key)} /> {key}</label>
                    ))}
                  </fieldset>
                  <label>
                    GitHub check run
                    <select
                      name="checkFailureSeverity"
                      defaultValue={repoSettings.settings.checkFailureSeverity ?? "off"}
                    >
                      <option value="off">neutral (never fails)</option>
                      {["critical", "high", "medium", "low"].map((s) => (
                        <option key={s} value={s}>fail at {s} or above</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Model override
                    <input
                      name="model"
                      defaultValue={repoSettings.settings.model}
                    />
                  </label>
                  <SummarySettings key={JSON.stringify([repoSettings.repo._id,repoSettings.settings.summarySections,repoSettings.settings.commentStyle])} initial={repoSettings.settings.summarySections} style={repoSettings.settings.commentStyle}/>
                  <fieldset className="wide">
                    <legend>Review categories</legend>
                    {[
                      "correctness",
                      "security",
                      "data",
                      "compatibility",
                      "testing",
                      "performance",
                      "rules",
                      "style",
                      "syntax",
                    ].map((c) => (
                      <label key={c}>
                        <span>
                          <input
                            type="checkbox"
                            name="categories"
                            value={c}
                            defaultChecked={repoSettings.settings.categories.includes(
                              c,
                            )}
                          />{" "}
                          {c}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  <label className="wide">
                    Custom instructions
                    <textarea
                      name="instructions"
                      rows={4}
                      defaultValue={repoSettings.settings.instructions}
                    />
                  </label>
                  <button className="primary">Save review settings</button>
                </fieldset></form>
                {!isAdmin&&<p>Workspace admin access is required to edit these settings.</p>}
                <h2>Learned team conventions</h2>
                {conventions.length === 0 ? <p className="muted">No conventions learned yet. OpenReview reads human review comments on merged pull requests daily and suggests recurring conventions here.</p> : <ul className="conventions" aria-label="Learned team conventions">{conventions.map((rule) => (
                  <li key={rule._id}><strong>{rule.text}</strong> <span className={`badge ${rule.status === "approved" ? "low" : rule.status === "rejected" ? "critical" : "medium"}`}>{rule.status}</span> · {rule.category} · seen {rule.frequency}×
                    <span className="muted"> · {rule.evidence.map((e, i) => <a key={e.url} href={e.url} rel="noreferrer">{i ? ", " : ""}@{e.author}</a>)}</span>
                    {isAdmin && <form action={decideConvention} className="inline-actions"><input type="hidden" name="ruleId" value={rule._id} />{rule.status !== "approved" && <button name="decision" value="approved">Approve</button>}{rule.status !== "rejected" && <button name="decision" value="rejected">Reject</button>}{rule.status === "approved" && <button name="decision" value="disabled">Disable</button>}</form>}
                  </li>
                ))}</ul>}
                <h2>Learned preferences</h2><Link href={"/dashboard/memory/preferences?repository="+repoSettings.repo._id}>Inspect sources and manage learned preferences</Link>

              </section>
            )}

          </>
        )
  );
}
