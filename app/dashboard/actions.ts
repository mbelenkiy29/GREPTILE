"use server";
import {scopeSettingsFromForm} from "../../src/scope-settings-form";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { backend, current } from "../../src/server";
import {approvalPolicySchema} from "../../src/approval";
import {runtimePolicySchema} from "../../src/runtime-policy";
import {approvalDefaults,runtimeDefaults} from "../../src/review-settings";

const text = (f: FormData, key: string) => z.string().parse(f.get(key) ?? "");
// One-shot confirmation shown by the dashboard Toaster after a redirect or revalidation.
async function notify(message: string, tone: "success" | "error" = "success") {
  (await cookies()).set("openreview_toast", encodeURIComponent(JSON.stringify({ text: message, tone })), { path: "/", sameSite: "lax", maxAge: 30, httpOnly: false, secure: process.env.NODE_ENV === "production" });
}
export async function saveApprovalPolicy(_state:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{
  const {token}=await current(),scope=text(form,"scope");
  if(scope!=="organization"&&!/^(team|repository):[a-z0-9]+$/.test(scope))throw new Error("Invalid policy scope");
  const lines=(key:string)=>text(form,key).split("\n").map(s=>s.trim()).filter(Boolean);
  const checks=lines("requiredChecks").map(line=>{const parts=line.split("|").map(s=>s.trim());if(parts.length>2)throw new Error("Use check name | optional App ID");return {name:parts[0],...(parts[1]?{appId:Number(parts[1])}:{})};});
  const policy=approvalPolicySchema.safeParse(form.get("inherit")==="true"?approvalDefaults:{enabled:form.has("enabled"),maximumRisk:text(form,"maximumRisk"),excludedPaths:lines("excludedPaths"),excludedAuthors:lines("excludedAuthors"),requiredChecks:checks});
  if(!policy.success)return {error:policy.error.issues.map(i=>i.path.includes("appId")?"Required check App IDs must be positive integers.":i.message).join("; ")};
  await backend().mutation(api.approvals.save,{token,organizationId:text(form,"organizationId") as Id<"organizations">,...(scope.startsWith("team:")?{teamId:scope.slice(5) as Id<"teams">}:{}),...(scope.startsWith("repository:")?{repositoryId:scope.slice(11) as Id<"repositories">}:{}),inherit:form.get("inherit")==="true",policy:policy.data});
  revalidatePath("/dashboard");return {saved:true};
 }catch(e){return {error:e instanceof Error?e.message:"Could not save approval policy"};}
}
export async function saveRuntimePolicy(_state:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{
  const {token}=await current(),scope=text(form,"scope");
  if(scope!=="organization"&&!/^(team|repository):[a-z0-9]+$/.test(scope))throw new Error("Invalid policy scope");
  const policy=runtimePolicySchema.safeParse(form.get("inherit")==="true"?runtimeDefaults:{enabled:form.get("enabled")==="on",image:text(form,"image").trim(),command:text(form,"command"),timeout:Number(text(form,"timeout")),requiredForApproval:form.get("requiredForApproval")==="true",generatedTests:form.get("generatedTests")==="true",testCommand:text(form,"testCommand").trim()});
  if(!policy.success)return {error:policy.error.issues.map(i=>i.message).join("; ")};
  await backend().mutation(api.runtime.save,{token,organizationId:text(form,"organizationId") as Id<"organizations">,...(scope.startsWith("team:")?{teamId:scope.slice(5) as Id<"teams">}:{}),...(scope.startsWith("repository:")?{repositoryId:scope.slice(11) as Id<"repositories">}:{}),inherit:form.get("inherit")==="true",policy:policy.data});
  revalidatePath("/dashboard");return {saved:true};
 }catch(e){return {error:e instanceof Error?e.message:"Could not save runtime policy"};}
}
export async function createRuntimeWorker(_state:{error?:string;credential?:string;url?:string},form:FormData):Promise<{error?:string;credential?:string;url?:string}>{
 try{
  const {token}=await current(),credential="orw_"+randomBytes(32).toString("hex");
  await backend().mutation(api.runtime.worker,{token,organizationId:text(form,"organizationId") as Id<"organizations">,name:text(form,"name"),hash:createHash("sha256").update(credential).digest("hex")});
  revalidatePath("/dashboard");return {credential,url:process.env.NEXT_PUBLIC_CONVEX_SITE_URL??""};
 }catch(e){return {error:e instanceof Error?e.message:"Could not create worker"};}
}
export async function revokeRuntimeWorker(form:FormData){const {token}=await current();await backend().mutation(api.runtime.revoke,{token,workerId:text(form,"workerId") as Id<"runtimeWorkers">});revalidatePath("/dashboard");}
export async function createWorkspace(form: FormData) {
  const { token } = await current();
  const id = await backend().mutation(api.users.createOrganization, {
    token,
    name: text(form, "name"),
  });
  (await cookies()).set("openreview_workspace", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  redirect("/dashboard/onboarding");
}
export async function selectOnboardingRepositories(_previous:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{const {token}=await current();await backend().mutation(api.onboarding.select,{token,organizationId:text(form,"organizationId") as Id<"organizations">,repositoryIds:form.getAll("repositoryIds").map(String) as Id<"repositories">[]});revalidatePath("/dashboard/onboarding");return {saved:true};}
 catch(e){return {error:e instanceof Error?e.message:"Could not save repository selection"};}
}
export async function startOnboardingIndexing(_previous:{error?:string},form:FormData):Promise<{error?:string}>{
 try{const {token}=await current();await backend().mutation(api.onboarding.start,{token,organizationId:text(form,"organizationId") as Id<"organizations">});revalidatePath("/dashboard/onboarding");return {};}
 catch(e){return {error:e instanceof Error?e.message:"Could not start indexing"};}
}
export async function switchWorkspace(form: FormData) {
  const user = await current(),
    id = text(form, "organizationId");
  if (!user.organizations.some((o) => o._id === id))
    throw new Error("Workspace not accessible");
  (await cookies()).set("openreview_workspace", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  (await cookies()).delete("openreview_team");
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/analytics");
}
export async function switchTeam(form:FormData){
 const user=await current(),jar=await cookies(),organization=user.organizations.find(o=>o._id===jar.get("openreview_workspace")?.value)??user.organizations[0];
 if(!organization?._id)throw new Error("Workspace required");
 const teamId=text(form,"teamId"),scopes=await backend().query(api.scopes.list,{token:user.token,organizationId:organization._id});
 if(teamId&&!scopes.teams.some(t=>t._id===teamId))throw new Error("Team not accessible");
 if(teamId)jar.set("openreview_team",teamId,{httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/"});else jar.delete("openreview_team");
 revalidatePath("/dashboard","layout");
 const returnTo=text(form,"returnTo");redirect(/^\/dashboard\/(analytics|memory|pulls|settings)(\/([a-z-]+))?$/.test(returnTo)?returnTo:"/dashboard/analytics");
}
export async function configureRepository(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.repositories.configure, {
    token,
    repositoryId: text(form, "repositoryId") as Id<"repositories">,
    enabled: text(form, "enabled") === "true",
  });
  await notify("Repository updated.");
  revalidatePath("/dashboard", "layout");
}
export async function reindex(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.repositories.reindex, {
    token,
    repositoryId: text(form, "repositoryId") as Id<"repositories">,
  });
  await notify("Re-index queued.");
  revalidatePath("/dashboard", "layout");
}
export async function saveRule(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.dashboard.rules, {
    token,
    organizationId: text(form, "organizationId") as Id<"organizations">,
    ...(text(form, "id") ? { id: text(form, "id") as Id<"customRules"> } : {}),
    remove: text(form, "remove") === "true",
    title: text(form, "title"),
    instructions: text(form, "instructions"),
    severity: text(form, "severity") || "medium",
    category: text(form, "category") || "rules",
    globs: text(form, "globs")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    enabled: text(form, "enabled") !== "false",
    ...(text(form, "repositoryId")
      ? { repositoryId: text(form, "repositoryId") as Id<"repositories"> }
      : {}),
  });
  await notify("Rule saved.");
  revalidatePath("/dashboard", "layout");
}
export async function feedback(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.dashboard.feedback, {
    token,
    findingId: text(form, "findingId") as Id<"findings">,
    value: text(form, "value"),
    comment: text(form, "comment"),
  });
  revalidatePath("/dashboard", "layout");
}
export async function invite(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.users.invite, {
    token,
    organizationId: text(form, "organizationId") as Id<"organizations">,
    githubLogin: text(form, "login"),
    role: z.enum(["admin", "member", "viewer"]).parse(text(form, "role")),
  });
  revalidatePath("/dashboard", "layout");
}
export async function acceptInvitation(_state:{error?:string},form: FormData):Promise<{error?:string}> {
  let organizationId:Id<"organizations">;
  try {
    const { token } = await current();
    organizationId = await backend().mutation(api.users.acceptInvitation, {
      token,invitationId: text(form, "invitationId") as Id<"invitations">,
    });
  } catch {
    return {error:"Invitation unavailable or expired. Refresh to see current invitations."};
  }
  const jar = await cookies();
  jar.set("openreview_workspace", organizationId, {
    httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV === "production",path:"/",
  });
  jar.delete("openreview_team");
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/analytics");
}
export async function revokeInvitation(_state:{error?:string},form:FormData):Promise<{error?:string}> {
  try {
    const {token}=await current();
    await backend().mutation(api.users.revokeInvitation,{token,invitationId:text(form,"invitationId") as Id<"invitations">});
  } catch {
    return {error:"Could not revoke this invitation. Refresh and check your workspace access."};
  }
  revalidatePath("/dashboard","layout");
  return {};
}
export async function logout() {
  const jar = await cookies(), token = jar.get("openreview_session")?.value;
  if (token) await backend().mutation(api.identity.signOut, { token }).catch(() => undefined);
  jar.delete("openreview_session");
  redirect("/");
}
export async function signOutEverywhere() {
  const { token } = await current();
  await backend().mutation(api.identity.signOutEverywhere, { token });
  (await cookies()).delete("openreview_session");
  redirect("/?signedout=1");
}
export async function revokeSession(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.identity.revokeSession, { token, sessionId: text(form, "sessionId") as Id<"sessions"> });
  await notify("Session signed out.");
  revalidatePath("/dashboard", "layout");
}
export async function inviteByEmail(form: FormData) {
  const { token } = await current();
  let outcome = "sent";
  try { outcome = await backend().action(api.identityJobs.inviteByEmail, { token, organizationId: text(form, "organizationId") as Id<"organizations">, email: text(form, "email"), role: z.enum(["admin", "member", "viewer"]).parse(text(form, "role")) }); }
  catch { outcome = "error"; }
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard/settings/people?emailInvite=${outcome}`);
}
export async function revokeEmailInvitation(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.identity.revokeEmailInvitation, { token, invitationId: text(form, "invitationId") as Id<"emailInvitations"> });
  revalidatePath("/dashboard", "layout");
}
export async function acceptEmailInvitation(form: FormData) {
  const { token } = await current();
  const raw = text(form, "token");
  let organizationId: string;
  try { organizationId = await backend().mutation(api.identity.acceptEmailInvitation, { token, tokenHash: createHash("sha256").update(raw).digest("hex") }); }
  catch { redirect("/invite?error=1"); }
  (await cookies()).set("openreview_workspace", organizationId, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  redirect("/dashboard");
}
export async function cancelReview(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.reviews.cancel, {
    token,
    reviewId: text(form, "reviewId") as Id<"reviews">,
  });
  revalidatePath("/dashboard", "layout");
}
export async function saveSettings(form: FormData) {
  const { token } = await current();
  const repositoryId = text(form, "repositoryId") as Id<"repositories">;
  const previous = await backend().query(api.settings.repository, {
    token,
    repositoryId,
  });
  const list = (key: string) =>
    text(form, key)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  await backend().mutation(api.repositories.configure, {
    token,
    repositoryId,
    enabled: previous.repo.enabled,
    settings: {
      automatic: form.has("automatic"),
      drafts: form.has("drafts"),
      rereview: form.has("rereview"),
      targetBranches: list("targetBranches"),
      ignoredBranches: list("ignoredBranches"),
      ignoredPaths: list("ignoredPaths"),
      maxComments: Number(text(form, "maxComments")),
      minimumConfidence: Number(text(form, "minimumConfidence")),
      severityThreshold: text(form, "severityThreshold"),
      categories: form.getAll("categories").map(String),
      mode: text(form, "mode"),
      model: text(form, "model"),
      instructions: text(form, "instructions"),
      commentStyle: text(form, "commentStyle"),
      reviewEngine: text(form, "reviewEngine") || previous.settings.reviewEngine || "pipeline",
      checkFailureSeverity: text(form, "checkFailureSeverity") || previous.settings.checkFailureSeverity || "off",
      triggerLabels: form.has("triggerLabels") ? list("triggerLabels") : previous.settings.triggerLabels ?? [],
      excludedAuthors: form.has("excludedAuthors") ? list("excludedAuthors") : previous.settings.excludedAuthors ?? [],
      maxFiles: form.has("maxFiles") ? Number(text(form, "maxFiles")) : previous.settings.maxFiles ?? 0,
      maxChangedLines: form.has("maxChangedLines") ? Number(text(form, "maxChangedLines")) : previous.settings.maxChangedLines ?? 0,
      strictness: form.has("strictness") ? Number(text(form, "strictness")) : previous.settings.strictness ?? 0,
      lockedKeys: form.has("lockedConfigured") ? form.getAll("lockedKeys").map(String) : previous.settings.lockedKeys ?? [],
      autoApproveConventions: form.has("conventionsConfigured") ? form.has("autoApproveConventions") : previous.settings.autoApproveConventions ?? false,
      fixPullRequests: form.has("fixConfigured") ? form.has("fixPullRequests") : previous.settings.fixPullRequests ?? false,
      threadReplies: form.has("threadRepliesConfigured") ? form.has("threadReplies") : previous.settings.threadReplies ?? true,
      securityScan: form.has("securityScanConfigured") ? form.has("securityScan") : previous.settings.securityScan ?? true,
      aiAuthoredModel: form.has("aiAuthoredModel") ? text(form, "aiAuthoredModel").trim() : previous.settings.aiAuthoredModel ?? "",
      maxReviewTier: form.has("maxReviewTier") ? text(form, "maxReviewTier") : previous.settings.maxReviewTier ?? "deep",
      ...Object.fromEntries((["agentTurns", "agentToolCalls", "hypothesisTurns", "hypothesisToolCalls"] as const).map((key) => [key, form.has(key) ? Number(text(form, key) || 0) : previous.settings[key] ?? 0])),
      summarySections:form.has("summaryConfigured")?form.getAll("summarySections").map(String):previous.settings.summarySections,
    },
  });
  await notify("Review settings saved.");
  revalidatePath("/dashboard", "layout");
}
export async function setMinutesPerFinding(form: FormData) {
  const { token } = await current();
  try { await backend().mutation(api.analytics.setMinutesPerFinding, { token, organizationId: text(form, "organizationId") as Id<"organizations">, minutes: Number(text(form, "minutes")) }); await notify("Time-saved estimate updated."); }
  catch { await notify("Only workspace admins can change the estimate (1–480 minutes).", "error"); }
  revalidatePath("/dashboard", "layout");
}
export async function startCheckout(form: FormData) {
  const { token } = await current();
  let url: string;
  try { url = await backend().action(api.billingJobs.checkout, { token, organizationId: text(form, "organizationId") as Id<"organizations"> }); }
  catch { redirect("/dashboard/settings/billing?billing=error"); }
  redirect(url);
}
export async function openBillingPortal(form: FormData) {
  const { token } = await current();
  let url: string;
  try { url = await backend().action(api.billingJobs.portal, { token, organizationId: text(form, "organizationId") as Id<"organizations"> }); }
  catch { redirect("/dashboard/settings/billing?billing=error"); }
  redirect(url);
}
export async function saveSlackChannel(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.notifications.saveChannel, { token, organizationId: text(form, "organizationId") as Id<"organizations">, channelId: text(form, "channelId"), repositoryIds: form.getAll("repositoryIds").map(String) as Id<"repositories">[], events: form.getAll("events").map(String), qa: form.has("qa") });
  await notify("Slack channel linked.");
  revalidatePath("/dashboard", "layout");
}
export async function removeSlackChannel(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.notifications.removeChannel, { token, channelId: text(form, "channelId") as Id<"notificationChannels"> });
  revalidatePath("/dashboard", "layout");
}
export async function disconnectSlack(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.notifications.disconnectSlack, { token, organizationId: text(form, "organizationId") as Id<"organizations"> });
  revalidatePath("/dashboard", "layout");
}
export async function saveNotificationPreferences(form: FormData) {
  const { token } = await current();
  const level = z.enum(["off", "mine", "all"]);
  await backend().mutation(api.notifications.savePreferences, { token, organizationId: text(form, "organizationId") as Id<"organizations">, reviewCompleted: level.parse(text(form, "reviewCompleted")), highSeverity: level.parse(text(form, "highSeverity")) });
  await notify("Email preferences saved.");
  revalidatePath("/dashboard", "layout");
}
export async function setNotificationEmail(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.notifications.setEmail, { token, organizationId: text(form, "organizationId") as Id<"organizations">, email: text(form, "email") });
  revalidatePath("/dashboard", "layout");
}
export async function askChat(form: FormData) {
  const { token } = await current();
  const threadId = text(form, "threadId");
  const result = await backend().mutation(api.chat.ask, { token, organizationId: text(form, "organizationId") as Id<"organizations">, ...(threadId ? { threadId: threadId as Id<"chatThreads"> } : {}), repositoryIds: form.getAll("repositoryIds").map(String).slice(0, 5) as Id<"repositories">[], question: text(form, "question") });
  redirect(`/dashboard/chat?thread=${result.threadId}`);
}
export async function deleteChatThread(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.chat.deleteThread, { token, threadId: text(form, "threadId") as Id<"chatThreads"> });
  redirect("/dashboard/chat");
}
export async function editPreference(form: FormData) {
  const { token } = await current();
  const scope = text(form, "scope");
  await backend().mutation(api.memory.editPreference, { token, preferenceId: text(form, "preferenceId") as Id<"learnedPreferences">, ...(form.has("instruction") ? { instruction: text(form, "instruction") } : {}), ...(scope ? { scope: z.enum(["repo", "team", "workspace"]).parse(scope) } : {}) });
  await notify("Preference updated.");
  revalidatePath("/dashboard", "layout");
}
export async function editLearnedRule(form: FormData) {
  const { token } = await current();
  const scope = text(form, "scope"), status = text(form, "status");
  await backend().mutation(api.memory.editLearnedRule, { token, ruleId: text(form, "ruleId") as Id<"learnedRules">, ...(form.has("text") ? { text: text(form, "text") } : {}), ...(scope ? { scope: z.enum(["repo", "team", "workspace"]).parse(scope) } : {}), ...(status ? { status: z.enum(["approved", "rejected", "disabled", "suggested"]).parse(status) } : {}) });
  await notify("Convention updated.");
  revalidatePath("/dashboard", "layout");
}
export async function deleteLearnedRule(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.memory.deleteLearnedRule, { token, ruleId: text(form, "ruleId") as Id<"learnedRules"> });
  await notify("Convention deleted.");
  revalidatePath("/dashboard", "layout");
}
export async function decideConvention(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.conventions.decide, { token, ruleId: text(form, "ruleId") as Id<"learnedRules">, decision: z.enum(["approved", "rejected", "disabled", "suggested"]).parse(text(form, "decision")) });
  await notify("Convention updated.");
  revalidatePath("/dashboard", "layout");
}
export async function resetPreference(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.settings.resetPreference, {
    token,
    preferenceId: text(form, "preferenceId") as Id<"learnedPreferences">,
  });
  await notify("Preference deleted.");
  revalidatePath("/dashboard", "layout");
}
export async function setPreferenceEnabled(form:FormData){
 const {token}=await current();await backend().mutation(api.settings.setPreferenceEnabled,{token,preferenceId:text(form,"preferenceId") as Id<"learnedPreferences">,enabled:text(form,"enabled")==="true"});await notify('Preference updated.');revalidatePath("/dashboard","layout");
}
export async function createApiKey(
  _previous: string,
  form: FormData,
): Promise<string> {
  const { token } = await current();
  const key = "or_" + randomBytes(32).toString("hex");
  await backend().mutation(api.apiKeys.create, {
    token,
    organizationId: text(form, "organizationId") as Id<"organizations">,
    name: text(form, "name"),
    hash: createHash("sha256").update(key).digest("hex"),
    prefix: key.slice(0, 11),
    scopes: [z.enum(["read", "write", "admin"]).parse(text(form, "scope") || "read")],
  });
  revalidatePath("/dashboard/settings/keys");
  return key;
}
export async function revokeApiKey(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.apiKeys.revoke, {
    token,
    keyId: text(form, "keyId") as Id<"apiKeys">,
  });
  await notify("API key revoked.");
  revalidatePath("/dashboard/settings/keys");
}
export async function updateMember(form: FormData) {
  const { token } = await current();
  await backend().mutation(api.team.update, {
    token,
    memberId: text(form, "memberId") as Id<"organizationMembers">,
    role: z.enum(["owner", "admin", "member", "viewer"]).parse(text(form, "role")),
    remove: text(form, "remove") === "true",
  });
  await notify("Member updated.");
  revalidatePath("/dashboard", "layout");
}
export async function approveBridge(form: FormData) {
 const {token}=await current(); await backend().mutation(api.bridge.approvePair,{token,organizationId:text(form,"organizationId") as Id<"organizations">,code:text(form,"code")});revalidatePath("/dashboard/settings/agents");
}
export async function reviewBridgePair(_state:{error?:string;code?:string;saved?:boolean;preview?:{deviceId:Id<"bridgeDevices">;name:string;expiresAt:number;account:string;userId:Id<"users">;organizationId:Id<"organizations">;workspace:string}},form:FormData):Promise<{error?:string;code?:string;saved?:boolean;preview?:{deviceId:Id<"bridgeDevices">;name:string;expiresAt:number;account:string;userId:Id<"users">;organizationId:Id<"organizations">;workspace:string}}>{
 const code=text(form,"code").trim().replaceAll("-","").toLowerCase();
 try{
  const {token}=await current(),organizationId=text(form,"organizationId") as Id<"organizations">;
  if(text(form,"deviceId")){
   await backend().mutation(api.bridge.approvePair,{token,organizationId,code,expectedDeviceId:text(form,"deviceId") as Id<"bridgeDevices">,expectedUserId:text(form,"userId") as Id<"users">});
   revalidatePath("/dashboard","layout");return {code,saved:true};
  }
  return {code,preview:await backend().mutation(api.bridge.previewPair,{token,organizationId,code})};
 }catch{return {code,error:"Pairing could not be reviewed or approved. Check workspace access and the current code, then review it again. Expired, revoked or already paired codes cannot be used."};}
}
export async function saveAgent(form:FormData) {
 const {token}=await current();const agent=text(form,"agent");await backend().mutation(api.bridge.savePersonal,{token,...(agent?{agent:z.enum(["codex","claude","cursor"]).parse(agent)}:{})});revalidatePath("/dashboard", "layout");
}
export async function saveWorkspaceAgent(form:FormData){
 const {token}=await current();await backend().mutation(api.bridge.saveWorkspaceAgent,{token,organizationId:text(form,"organizationId") as Id<"organizations">,agent:z.enum(["codex","claude","cursor"]).parse(text(form,"agent"))});revalidatePath("/dashboard", "layout");
}
export async function revokeBridge(form:FormData) {
 const {token}=await current();await backend().mutation(api.bridge.revoke,{token,deviceId:text(form,"deviceId") as Id<"bridgeDevices">});revalidatePath("/dashboard/settings/agents");
}
export async function launchFix(_previous:{url?:string;error?:string},form:FormData):Promise<{url?:string;error?:string}> {
 try {const {token}=await current(); const id=await backend().mutation(api.bridge.createFix,{token,reviewId:text(form,"reviewId") as Id<"reviews">,...(text(form,"findingId")?{findingId:text(form,"findingId") as Id<"findings">}:{}),agent:z.enum(["codex","claude","cursor"]).parse(text(form,"agent"))});return {url:`openreview://fix?request=${id}`};}
 catch(error){return {error:error instanceof Error ? error.message.slice(0,500):"Unable to create fix request"};}
}
export async function reviewAgain(form:FormData) {
 const {token}=await current();const review=await backend().query(api.reviews.detail,{token,reviewId:text(form,"reviewId") as Id<"reviews">});
 if(review.review.nativeP4&&review.review.status==="failed"&&review.review.resultStorageId&&text(form,"fresh")!=="true"){await backend().mutation(api.p4Reviews.retryPublication,{token,reviewId:review.review._id});revalidatePath("/dashboard","layout");redirect("/dashboard/pulls/"+review.review._id);}
 const id=review.review.nativeP4?await backend().action(api.p4ReviewJobs.request,{token,organizationId:review.review.organizationId,repositoryId:review.review.repositoryId,nativeNumber:review.review.prNumber,force:true}):await backend().action(api.providerJobs.rereview,{token,repositoryId:review.review.repositoryId,prNumber:review.review.prNumber});revalidatePath("/dashboard", "layout");if(id)redirect("/dashboard/pulls/"+id);
}
export async function createTeam(form:FormData) {
 const {token}=await current();await backend().mutation(api.scopes.createTeam,{token,organizationId:text(form,"organizationId") as Id<"organizations">,name:text(form,"name")});revalidatePath("/dashboard","layout");
}
export async function assignTeam(form:FormData) {
 const {token}=await current();await backend().mutation(api.scopes.assign,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">,...(text(form,"teamId")?{teamId:text(form,"teamId") as Id<"teams">}:{})});revalidatePath("/dashboard","layout");
}
export async function teamMember(form:FormData) {
 const {token}=await current();await backend().mutation(api.scopes.member,{token,teamId:text(form,"teamId") as Id<"teams">,userId:text(form,"userId") as Id<"users">,role:z.enum(["admin","member","viewer"]).parse(text(form,"role")),remove:text(form,"remove")==="true"});revalidatePath("/dashboard","layout");
}
export async function inheritSettings(form:FormData) {
 const {token}=await current();await backend().mutation(api.scopes.inherit,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">});revalidatePath("/dashboard","layout");
}
export async function saveScope(form:FormData) {
 const {token}=await current();
 await backend().mutation(api.scopes.save,{token,organizationId:text(form,"organizationId") as Id<"organizations">,...(text(form,"teamId")?{teamId:text(form,"teamId") as Id<"teams">}:{}),overrideKeys:form.getAll("overrideKeys").map(String),settings:scopeSettingsFromForm(form)});
 revalidatePath("/dashboard","layout");
}
export async function saveCluster(form:FormData) {
 const {token}=await current();await backend().mutation(api.scopes.cluster,{token,organizationId:text(form,"organizationId") as Id<"organizations">,...(text(form,"id")?{id:text(form,"id") as Id<"repositoryClusters">}:{}),name:text(form,"name"),repositoryIds:form.getAll("repositoryIds").map(String) as Id<"repositories">[],remove:text(form,"remove")==="true"});revalidatePath("/dashboard","layout");
}
export async function saveClusterForm(_previous:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}> {
 const name=text(form,"name").trim(),ids=form.getAll("repositoryIds").map(String);
 if(!name||name.length>100)return {error:"Enter a cluster name of 1–100 characters."};
 if(ids.length<2||ids.length>20||new Set(ids).size!==ids.length)return {error:"Choose 2–20 distinct repositories."};
 try{form.set("name",name);await saveCluster(form);return {saved:true};}
 catch{return {error:"Could not save this cluster. Check your workspace admin access and repository selections, then retry."};}
}
export async function connectProvider(_previous:{error?:string},form:FormData):Promise<{error?:string}> {
 try{
  const user=await current(),token=user.token,organizationId=text(form,"organizationId") as Id<"organizations">;
  if(!user.organizations.some(o=>o._id===organizationId && ["owner","admin"].includes(o.role)))throw new Error("Workspace admin required");
  const kind=z.enum(["gitlab","github-enterprise","gitea","bitbucket-dc","perforce","azure-devops"]).parse(text(form,"kind"));
  const {encryptCredential,providerOrigin}=await import("../../src/credentials");
  const instance=providerOrigin(text(form,"instance"),kind==="gitlab"?["gitlab.com"]:kind==="azure-devops"?["dev.azure.com"]:[]);
  const credential=text(form,"credential"),webhook=text(form,"webhookSecret");
  if(credential.length<10||credential.length>20000||kind!=="perforce"&&webhook.length<32)throw new Error("Credentials required; webhook providers need a secret of at least 32 characters");
  let config:unknown;
  if(["github-enterprise","bitbucket-dc","perforce"].includes(kind)){try{config=JSON.parse(credential);}catch{throw new Error("Credential must be valid JSON with the fields shown in setup");}}
  if(kind==="gitlab"){const {Gitlab}=await import("../../src/gitlab");await new Gitlab(instance,credential).repositories();}
  else if(kind==="gitea"){const {Gitea}=await import("../../src/gitea");await new Gitea(instance,credential).discover();}
  else if(kind==="azure-devops"){if(!/^https:\/\/[^/]+\/[^/]+/.test(instance))throw new Error("Use the organization URL, for example https://dev.azure.com/your-organization");const {AzureDevOps}=await import("../../src/azure-devops");await new AzureDevOps(instance,credential).repositories();}
  else if(kind==="bitbucket-dc"){const {BitbucketDC}=await import("../../src/bitbucket-dc");const c=z.object({token:z.string().min(10),username:z.string().min(1)}).safeParse(config);if(!c.success)throw new Error("Bitbucket credential requires a token (10+ characters) and bot username");await new BitbucketDC(instance,c.data.token,undefined,c.data.username).repositories();}
  else if(kind==="perforce"){const {P4CodeReview,p4Credential}=await import("../../src/perforce");const c=p4Credential.safeParse(config);if(!c.success)throw new Error("P4 credential requires only username and ticket, as shown in setup");await new P4CodeReview(instance,c.data.username,c.data.ticket).projects();}
  else{const {Github}=await import("../../src/github");const c=z.object({appId:z.string(),privateKey:z.string(),installationId:z.number().int().positive()}).safeParse(config);if(!c.success)throw new Error("Enterprise credential requires appId, privateKey, and a positive installationId");await (await Github.installation(c.data.installationId,{appId:c.data.appId,privateKey:c.data.privateKey,base:instance+(new URL(instance).hostname.endsWith(".ghe.com")?"":"/api/v3")})).repositories();}
  await backend().mutation(api.providerConnections.save,{token,secret:process.env.SERVICE_SECRET??"",organizationId,kind,instance,name:text(form,"name"),credentials:encryptCredential(credential,organizationId+":"+kind),webhookSecret:kind==="perforce"?"":encryptCredential(webhook,organizationId+":"+kind+":webhook")});
  revalidatePath("/dashboard","layout");return {};
 }catch(error){return {error:error instanceof Error?error.message:"Connection failed"};}
}
export async function authorizeBitbucket(_previous:{error?:string;code?:string;id?:string;expiresAt?:number},form:FormData):Promise<{error?:string;code?:string;id?:string;expiresAt?:number}>{
 try{
  const {token}=await current();
  if(!process.env.BITBUCKET_FORGE_APP_ID||!process.env.BITBUCKET_FORGE_ENVIRONMENT_ID)throw new Error("The operator must register the OpenReview Forge app first");
  const code=randomBytes(32).toString("hex");
  const grant=await backend().mutation(api.providerInstalls.beginBitbucket,{token,organizationId:text(form,"organizationId") as Id<"organizations">,tokenHash:createHash("sha256").update(code).digest("hex")});
  return {code,id:grant.id,expiresAt:grant.expiresAt};
 }catch{return {error:"Could not authorize installation. Check workspace admin access and Forge registration."};}
}
export async function revokeBitbucketAuthorization(form:FormData){
 const {token}=await current();await backend().mutation(api.providerInstalls.revoke,{token,id:text(form,"id") as Id<"providerInstallRequests">});revalidatePath("/dashboard/settings/providers");
}
export async function selectProviderRepos(form:FormData) {
 const {token}=await current();await backend().action(api.providerJobs.select,{token,connectionId:text(form,"connectionId") as Id<"providerConnections">,externalIds:form.getAll("externalIds").map(String)});revalidatePath("/dashboard","layout");
}
export async function refreshP4Ticket(_state:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{const {token}=await current();await backend().action(api.providerJobs.refreshP4Ticket,{token,connectionId:text(form,"connectionId") as Id<"providerConnections">,ticket:text(form,"ticket")});revalidatePath("/dashboard","layout");return {saved:true};}
 catch{return {error:"Ticket renewal failed. Check the existing bot identity, selected project access and workspace admin permission."};}
}
export async function replaceGitCredentials(_state:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{const {token}=await current();await backend().action(api.providerJobs.replaceGitCredentials,{token,connectionId:text(form,"connectionId") as Id<"providerConnections">,credential:text(form,"credential")});revalidatePath("/dashboard","layout");return {saved:true};}
 catch{return {error:"Credential replacement failed. Check workspace admin permission and access to every selected repository. The connection may have changed while verification ran."};}
}
export async function disconnectProvider(form:FormData) {
 const {token}=await current();await backend().mutation(api.providerConnections.disconnect,{token,id:text(form,"connectionId") as Id<"providerConnections">});revalidatePath("/dashboard","layout");
}
export async function configureLinear(form:FormData) {
 const {token}=await current(),id=text(form,"integrationId") as Id<"integrationConnections">;
 try {await backend().action(api.integrationJobs.configure,{token,id,teamIds:form.getAll("teamIds").map(String),projectIds:form.getAll("projectIds").map(String),repositoryIds:form.getAll("repositoryIds").map(String) as Id<"repositories">[]});}
 catch {redirect("/dashboard/memory/integrations?error=linear-scope&integration="+encodeURIComponent(id));}
 revalidatePath("/dashboard","layout");redirect("/dashboard/memory/integrations?saved=true&integration="+encodeURIComponent(id));
}
export async function disconnectLinear(form:FormData) {
 const {token}=await current(),id=text(form,"integrationId") as Id<"integrationConnections">;
 try {await backend().mutation(api.integrations.disconnect,{token,id});}
 catch {redirect("/dashboard/memory/integrations?error=disconnect");}
 revalidatePath("/dashboard","layout");redirect("/dashboard/memory/integrations?saved=disconnected");
}
export async function configureNotion(form:FormData) {
 const {token}=await current(),id=text(form,"integrationId") as Id<"integrationConnections">;
 try {await backend().action(api.notionJobs.configure,{token,id,repositoryIds:form.getAll("repositoryIds").map(String) as Id<"repositories">[]});}
 catch {redirect("/dashboard/memory/integrations?error=notion-scope&integration="+encodeURIComponent(id));}
 revalidatePath("/dashboard","layout");redirect("/dashboard/memory/integrations?saved=true&integration="+encodeURIComponent(id));
}
export async function refreshLinear(form:FormData) {
 const {token}=await current(),id=text(form,"integrationId") as Id<"integrationConnections">;
 try {await backend().action(api.integrationJobs.refresh,{token,id});}
 catch {redirect("/dashboard/memory/integrations?error=linear-refresh&integration="+encodeURIComponent(id));}
 revalidatePath("/dashboard","layout");redirect("/dashboard/memory/integrations?saved=linear-refresh&integration="+encodeURIComponent(id));
}

export async function configureAtlassian(form:FormData) {
 const {token}=await current(),id=text(form,"integrationId") as Id<"integrationConnections">;
 try {await backend().action(api.atlassianJobs.configure,{token,id,jiraProjectIds:form.getAll("jiraProjectIds").map(String),confluenceSpaceIds:form.getAll("confluenceSpaceIds").map(String),repositoryIds:form.getAll("repositoryIds").map(String) as Id<"repositories">[]});}
 catch {redirect("/dashboard/memory/integrations?error=atlassian-scope&integration="+encodeURIComponent(id));}
 revalidatePath("/dashboard","layout");redirect("/dashboard/memory/integrations?saved=true&integration="+encodeURIComponent(id));
}

export async function activateBitbucket(_state:{error?:string},form:FormData):Promise<{error?:string}>{
 try{const {token}=await current();await backend().action(api.providerJobs.activateBitbucket,{token,connectionId:text(form,"connectionId") as Id<"providerConnections">});revalidatePath("/dashboard","layout");return {};}
 catch{return {error:"Activation failed. Verify recent native event delivery, scheduled renewal, workspace repository access and administrator permissions, then retry."};}
}

export async function reviewP4Shelf(form:FormData){
 const {token}=await current();const id=await backend().action(api.p4ReviewJobs.request,{token,organizationId:text(form,"organizationId") as Id<"organizations">,repositoryId:text(form,"repositoryId") as Id<"repositories">,nativeNumber:Number(text(form,"nativeNumber"))});revalidatePath("/dashboard","layout");redirect("/dashboard/pulls/"+id);
}

export async function configureP4Polling(form:FormData){
 const {token}=await current();await backend().mutation(api.p4Polling.configure,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">,enabled:text(form,"enabled")==="true"});revalidatePath("/dashboard","layout");
}

export async function connectP4Identity(_state:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{
  const {token}=await current();
  await backend().action(api.p4IdentityJobs.connect,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">,username:text(form,"username").trim(),ticket:text(form,"ticket").trim()});
  revalidatePath("/dashboard/settings/agents");return {saved:true};
 }catch(error){return {error:error instanceof Error?error.message:"Could not link native identity"};}
}
export async function revokeP4Identity(form:FormData){const {token}=await current();await backend().mutation(api.p4Identities.revoke,{token,identityId:text(form,"identityId") as Id<"p4Identities">});revalidatePath("/dashboard/settings/agents");}

export async function retryP4Answer(form:FormData){const {token}=await current();await backend().mutation(api.p4Conversations.retry,{token,conversationId:text(form,"conversationId") as Id<"conversations">});revalidatePath("/dashboard/pulls");}

export async function connectProviderIdentity(_state:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{const {token}=await current();await backend().action(api.providerIdentityJobs.connect,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">,personalToken:text(form,"personalToken").trim()});revalidatePath("/dashboard/settings/agents");return {saved:true};}catch{return {error:"Could not verify your provider account. Check your token, profile permission and repository access."};}
}
export async function revokeProviderIdentity(form:FormData){const {token}=await current();await backend().mutation(api.providerIdentities.revoke,{token,id:text(form,"identityId") as Id<"providerIdentities">});revalidatePath("/dashboard/settings/agents");}

export async function beginBitbucketIdentity(_state:{error?:string;code?:string;expiresAt?:number},form:FormData):Promise<{error?:string;code?:string;expiresAt?:number}>{
 try{const {token}=await current(),code=randomBytes(32).toString("hex"),result=await backend().mutation(api.bitbucketPersonal.begin,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">,tokenHash:createHash("sha256").update(code).digest("hex")});return {code,expiresAt:result.expiresAt};}catch{return {error:"Could not authorize Bitbucket identity. Check your repository access and active installation."};}
}

export async function retryProviderEvent(form:FormData){
 const {token}=await current();await backend().mutation(api.providerConnections.retryEvent,{token,id:text(form,"eventId") as Id<"providerEvents">});revalidatePath("/dashboard/settings/providers");
}

export async function syncPullCatalog(_state:{error?:string;saved?:boolean},form:FormData):Promise<{error?:string;saved?:boolean}>{
 try{const {token}=await current();await backend().mutation(api.pullCatalogs.sync,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">});revalidatePath("/dashboard/pulls");return {saved:true};}catch(e){return {error:e instanceof Error?e.message:"Could not import pull requests"};}
}

export async function requestCatalogReview(_state:{error?:string},form:FormData):Promise<{error?:string}>{
 let id:Id<"reviews">|null=null;
 try{const {token}=await current();id=await backend().action(api.pullReviewJobs.request,{token,repositoryId:text(form,"repositoryId") as Id<"repositories">,prNumber:Number(text(form,"prNumber")),expectedRevision:text(form,"expectedRevision"),expectedBaseRevision:text(form,"expectedBaseRevision")});revalidatePath("/dashboard/pulls");}catch{return {error:"Could not start this review. Refresh the list and check repository access, indexing, and whether the change is still open."};}
 if(id)redirect("/dashboard/pulls/"+id);return {error:"Review could not be queued. Check repository access and current revision."};
}
