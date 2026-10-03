"use client";

import { useActionState } from "react";
import type { ConnectState } from "@/app/dashboard/settings/git-providers/actions";

/**
 * Connects GitLab (instance URL + access token) or a Bitbucket Cloud workspace (workspace + access token, or app
 * password with its username) (R3.6). The token is sent once, validated against the host, and stored encrypted; it is
 * never shown again.
 */
export function ConnectProviderForm({
  provider,
  action,
  defaultGitLabUrl,
}: {
  provider: "gitlab" | "bitbucket";
  action: (prev: ConnectState, formData: FormData) => Promise<ConnectState>;
  defaultGitLabUrl?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const id = (name: string) => `${provider}-${name}`;
  return (
    <form action={formAction} className="stack-md" data-testid={`connect-${provider}`}>
      {provider === "gitlab" ? (
        <div className="field">
          <label className="field-label" htmlFor={id("url")}>
            GitLab URL
          </label>
          <input id={id("url")} className="input" name="baseUrl" type="url" defaultValue={defaultGitLabUrl ?? "https://gitlab.com"} required autoComplete="off" />
        </div>
      ) : (
        <>
          <div className="field">
            <label className="field-label" htmlFor={id("workspace")}>
              Workspace ID
            </label>
            <input id={id("workspace")} className="input" name="workspace" placeholder="my-team" required autoComplete="off" />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={id("username")}>
              Username <span className="dim">(only for an app password or API token)</span>
            </label>
            <input id={id("username")} className="input" name="username" autoComplete="off" />
          </div>
        </>
      )}
      <div className="field">
        <label className="field-label" htmlFor={id("token")}>
          {provider === "gitlab" ? "Access token" : "Access token or app password"}
        </label>
        <input id={id("token")} className="input mono" name="token" type="password" required autoComplete="off" />
        <span className="field-help">
          {provider === "gitlab"
            ? "A group or project access token (Maintainer role) with the api and read_repository scopes."
            : "A workspace access token with repository, pull request (write), and webhook scopes."}
        </span>
      </div>
      {state.message && (
        <p role={state.status === "error" ? "alert" : "status"} className={state.status === "error" ? "error-text" : undefined}>
          {state.message}
        </p>
      )}
      <div>
        <button className="button button-primary" type="submit" disabled={pending}>
          {pending ? "Checking…" : provider === "gitlab" ? "Connect GitLab" : "Connect Bitbucket"}
        </button>
      </div>
    </form>
  );
}
