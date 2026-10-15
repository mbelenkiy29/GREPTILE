"use client";
import { useActionState, useEffect, useMemo, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { ConnectArt, RepoTreeArt, Stage } from "./art";

type Result = { error?: string; message?: string };
type Action = (state: Result, form: FormData) => Promise<Result>;

function Pending({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return pending ? <p className="muted" role="status">{label}</p> : null;
}
/** The step's form; the bottom bar's Next button submits it through form="wizard-form". */
export function StepForm({ action, pendingLabel = "Saving…", disabled, children, className }: { action: Action; pendingLabel?: string; disabled?: boolean; children: ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, {});
  return <form id="wizard-form" action={formAction} className={className}>
    <fieldset disabled={disabled} className="wizard-fieldset">{children}</fieldset>
    {state.error && <p role="alert" className="wizard-error">{state.error}</p>}
    {state.message && <p role="status">{state.message}</p>}
    <Pending label={pendingLabel} />
  </form>;
}

/** ⌘/Ctrl+Enter advances; on each step focus moves to its heading for screen-reader users. */
export function WizardShortcuts({ nextHref }: { nextHref?: string }) {
  const router = useRouter();
  useEffect(() => {
    document.querySelector<HTMLElement>("[data-wizard-heading]")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing) return;
      const form = document.getElementById("wizard-form") as HTMLFormElement | null;
      event.preventDefault();
      if (form && !form.querySelector("fieldset:disabled")) form.requestSubmit();
      else if (nextHref) router.push(nextHref);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nextHref, router]);
  return null;
}
export function ShortcutHint() {
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  return <kbd>{mac ? "⌘" : "Ctrl"} ↵</kbd>;
}

type Repo = { _id: string; fullName: string; provider: string; detail: string; selected: boolean; setupError?: string | null; status: string };
/** Step 2: connect a provider, see the linked accounts, pick repositories (with search). */
export function ConnectStep({ action, organizationId, repositories, accounts, githubHref, providersHref, admin, error, heading }: {
  action: Action; organizationId: string; repositories: Repo[]; accounts: { label: string; kind: string }[];
  githubHref?: string; providersHref: string; admin: boolean; error?: string; heading: ReactNode;
}) {
  const [selected, setSelected] = useState(() => new Set(repositories.filter((r) => r.selected && !r.setupError).map((r) => r._id)));
  const [query, setQuery] = useState("");
  const visible = useMemo(() => repositories.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase())), [repositories, query]);
  const connected = accounts.length > 0;
  const toggle = (id: string, on: boolean) => setSelected((old) => { const next = new Set(old); if (on) next.add(id); else next.delete(id); return next; });
  const selectable = visible.filter((r) => !r.setupError);
  const state = (n: number) => n === 1 ? (connected ? "done" : "current") : n === 2 ? (connected ? (selected.size ? "done" : "current") : "pending") : connected ? "current" : "pending";
  return <>
    <div className="wizard-panel">
      {heading}
      <StepForm action={action} pendingLabel="Starting indexing…" disabled={!admin}>
        <input type="hidden" name="organizationId" value={organizationId} />
        {error && <p role="alert" className="wizard-error">{error}</p>}
        <ol className="wizard-steps">
          <li data-state={state(1)}>
            <span className="num">{connected ? "✓" : "1"}</span>
            <div><strong>Connect a code provider</strong>
              <p className="muted">{connected ? "Connected. OpenReview reads repositories through the access you granted." : "Install the GitHub App, or connect GitLab, Bitbucket, Azure DevOps, Gitea or Perforce."}</p>
              <div className="row">
                {githubHref ? <a className={`button${connected ? "" : " primary"}`} href={githubHref}>{connected ? "Add a GitHub account" : "Install GitHub App"}</a>
                  : <span className="muted">GitHub App installs need GITHUB_APP_SLUG and GITHUB_CLIENT_ID on the server.</span>}
                <a className="button" href={providersHref}>Other providers</a>
              </div>
            </div>
          </li>
          <li data-state={state(2)}>
            <span className="num">{connected ? "✓" : "2"}</span>
            <div><strong>Linked accounts</strong>
              {connected ? <ul className="wizard-accounts">{accounts.map((a) => <li key={a.kind + a.label}><span className="badge">{a.kind}</span> {a.label}</li>)}</ul>
                : <p className="muted">Accounts and organizations appear here after you connect.</p>}
              {connected && githubHref && <p className="muted"><a href={githubHref}>Don’t see your organization? Install on another account.</a></p>}
            </div>
          </li>
          <li data-state={state(3)}>
            <span className="num">3</span>
            <div><strong>Choose repositories to review</strong>
              {repositories.length ? <div className="repo-picker">
                <div className="toolbar">
                  <label className="grow">Filter repositories<input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="owner/name" /></label>
                  <button type="button" className="small" onClick={() => setSelected(new Set([...selected, ...selectable.map((r) => r._id)]))}>Select shown</button>
                  <button type="button" className="small" onClick={() => setSelected(new Set())}>Clear</button>
                </div>
                <ul>{visible.map((r) => <li key={r._id}><label className="check">
                  <input type="checkbox" name="repositoryIds" title={r.detail} value={r._id} checked={selected.has(r._id)} disabled={Boolean(r.setupError)} onChange={(e) => toggle(r._id, e.target.checked)} />
                  <span><span className="mono">{r.fullName}</span> <span className="muted">{r.provider}{r.setupError ? ` · ${r.setupError}` : ""}</span></span>
                </label></li>)}
                {!visible.length && <li className="muted">No repositories match “{query}”.</li>}</ul>
                <p className="muted" aria-live="polite">{selected.size} of {repositories.length} selected. Indexing starts when you continue; automatic reviews stay paused until you choose when reviews run.</p>
              </div> : <p className="muted">{connected ? "No repositories are available yet. Check the App’s repository access, then reload." : "Connect a provider first."}</p>}
            </div>
          </li>
        </ol>
      </StepForm>
    </div>
    {connected
      ? <Stage caption={`${selected.size} ${selected.size === 1 ? "repository" : "repositories"} selected`}><RepoTreeArt account={accounts[0].label} repositories={repositories.map((r) => ({ name: r.fullName, selected: selected.has(r._id) }))} /></Stage>
      : <Stage caption="waiting for a code provider"><ConnectArt provider="GH" connected={false} /></Stage>}
  </>;
}

export function InviteForm({ action, organizationId, disabled }: { action: Action; organizationId: string; disabled?: boolean }) {
  const [state, formAction] = useActionState(action, {});
  return <form id="wizard-invite" action={formAction} className="wizard-invite">
    <input type="hidden" name="organizationId" value={organizationId} />
    <fieldset disabled={disabled} className="wizard-fieldset">
      <div className="form-grid">
        <label>GitHub username<input name="login" placeholder="octocat" autoComplete="off" /></label>
        <label>Role<select name="role" defaultValue="member"><option value="member">Member</option><option value="admin">Admin</option><option value="viewer">Viewer</option></select></label>
      </div>
      <button>Send invitation</button>
    </fieldset>
    {state.error && <p role="alert" className="wizard-error">{state.error}</p>}
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}
