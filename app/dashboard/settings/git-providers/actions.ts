"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { recordAudit } from "@/lib/data/audit";
import { errorMessage, log } from "@/lib/log";
import {
  checkConnection,
  connectBitbucket,
  connectGitLab,
  disableConnectionRepo,
  disconnectConnection,
  enableConnectionRepo,
  ScmConnectError,
} from "@/lib/scm/connections";
import { productionScmDeps } from "@/lib/scm/deps";
import { safeReturnPath, withToast, type ToastCode } from "@/lib/ui/toast";

const PATH = "/dashboard/settings/git-providers";

export interface ConnectState {
  status?: "connected" | "error";
  message?: string;
}

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

function idOf(formData: FormData, key: string): number | null {
  const n = Number(formData.get(key));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function connect(provider: "gitlab" | "bitbucket", formData: FormData): Promise<ConnectState> {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const deps = productionScmDeps();
  try {
    const created =
      provider === "gitlab"
        ? await connectGitLab(deps, { orgId, userId, baseUrl: str(formData, "baseUrl"), token: str(formData, "token") })
        : await connectBitbucket(deps, { orgId, userId, workspace: str(formData, "workspace"), token: str(formData, "token"), username: str(formData, "username") });
    await recordAudit(deps.db, { orgId, actorType: "user", actorId: userId, action: "scm.connected", targetType: "scm_credential", targetId: created.credentialId, metadata: { provider } });
    revalidatePath(PATH);
    return { status: "connected", message: `${provider === "gitlab" ? "GitLab" : "Bitbucket"} connected. Choose repositories to review below.` };
  } catch (err) {
    if (err instanceof ScmConnectError) return { status: "error", message: err.message };
    log.error("could not connect a git provider", { orgId, provider, error: errorMessage(err) });
    return { status: "error", message: "The connection could not be saved. Try again." };
  }
}

/** Connects GitLab with an access token (R3.6). Admins only. */
export async function connectGitLabAction(_prev: ConnectState, formData: FormData): Promise<ConnectState> {
  return connect("gitlab", formData);
}

/** Connects a Bitbucket Cloud workspace (R3.6). Admins only. */
export async function connectBitbucketAction(_prev: ConnectState, formData: FormData): Promise<ConnectState> {
  return connect("bitbucket", formData);
}

/** Re-checks a connection's token (validity, scopes, expiry). */
export async function checkConnectionAction(formData: FormData) {
  const { orgId } = await requireOrg({ permission: "repos.manage" });
  const id = idOf(formData, "credentialId");
  const result = id === null ? undefined : await checkConnection(productionScmDeps(), orgId, id);
  revalidatePath(PATH);
  redirect(withToast(PATH, !result ? "scm.not_found" : result.status === "invalid" ? "scm.check_failed" : "scm.checked"));
}

/** Disconnects a provider: removes OpenReview's webhooks, the stored token, and the connection's repositories. */
export async function disconnectAction(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const id = idOf(formData, "credentialId");
  const deps = productionScmDeps();
  const done = id !== null && (await disconnectConnection(deps, orgId, id));
  if (done) await recordAudit(deps.db, { orgId, actorType: "user", actorId: userId, action: "scm.disconnected", targetType: "scm_credential", targetId: id });
  revalidatePath(PATH);
  revalidatePath("/dashboard/repos");
  redirect(withToast(PATH, done ? "scm.disconnected" : "scm.not_found"));
}

/** Enables reviews for a repository of a connection: creates its webhook and queues its first index. */
export async function enableRepoAction(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const credentialId = idOf(formData, "credentialId");
  const externalId = idOf(formData, "externalId");
  const back = safeReturnPath(formData.get("returnTo"), PATH);
  if (credentialId === null || externalId === null) redirect(withToast(back, "scm.not_found"));
  const deps = productionScmDeps();
  let code: ToastCode = "scm.repo_enabled";
  try {
    const repo = await enableConnectionRepo(deps, orgId, credentialId, externalId);
    if (!repo) code = "scm.not_found";
    else await recordAudit(deps.db, { orgId, actorType: "user", actorId: userId, action: "repo.enabled", targetType: "repo", targetId: repo.id, metadata: { fullName: repo.fullName } });
  } catch (err) {
    log.warn("could not enable a repository", { orgId, credentialId, externalId, error: errorMessage(err) });
    code = "scm.hook_failed";
  }
  revalidatePath(PATH);
  revalidatePath("/dashboard/repos");
  redirect(withToast(back, code));
}

/** Pauses reviews for a repository and removes its webhook. */
export async function disableRepoAction(formData: FormData) {
  const { orgId, userId } = await requireOrg({ permission: "repos.manage" });
  const repoId = idOf(formData, "repoId");
  const back = safeReturnPath(formData.get("returnTo"), PATH);
  const deps = productionScmDeps();
  let code: ToastCode = "scm.repo_disabled";
  try {
    const done = repoId !== null && (await disableConnectionRepo(deps, orgId, repoId));
    if (!done) code = "scm.not_found";
    else await recordAudit(deps.db, { orgId, actorType: "user", actorId: userId, action: "repo.disabled", targetType: "repo", targetId: repoId });
  } catch (err) {
    log.warn("could not disable a repository", { orgId, repoId, error: errorMessage(err) });
    code = "scm.hook_failed";
  }
  revalidatePath(PATH);
  revalidatePath("/dashboard/repos");
  redirect(withToast(back, code));
}
