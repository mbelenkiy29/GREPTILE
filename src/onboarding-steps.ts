// Guided workspace setup: the step registry, the settings each configuration step may change, and
// the resume/guard rules shared by the wizard pages and the Convex onboarding functions.
export const wizardSteps = ["workspace", "connect", "indexing", "summary", "comments", "triggers", "tools", "team", "plan", "done"] as const;
export type WizardStep = (typeof wizardSteps)[number];
export const configureSteps = ["summary", "comments", "triggers", "tools"] as const;
export type ConfigureStep = (typeof configureSteps)[number];

export const stepTitles: Record<WizardStep, string> = {
  workspace: "Create your workspace",
  connect: "Connect your code",
  indexing: "Mapping your repositories",
  summary: "Shape the review summary",
  comments: "Choose what gets flagged",
  triggers: "Decide when reviews run",
  tools: "Fixes and safeguards",
  team: "Bring in your team",
  plan: "Choose your plan",
  done: "Setup complete",
};
// Short labels for the configuration progress bar.
export const configureLabels: Record<ConfigureStep, string> = { summary: "Summary", comments: "Comments", triggers: "Triggers", tools: "Tools" };

// The only workspace settings each configuration step writes; the server enforces the same lists.
export const stepKeys: Record<ConfigureStep, readonly string[]> = {
  summary: ["summarySections", "commentStyle"],
  comments: ["severityThreshold", "categories", "maxComments", "minimumConfidence", "strictness"],
  triggers: ["automatic", "drafts", "rereview", "triggerLabels", "threadReplies"],
  tools: ["securityScan", "fixPullRequests", "mode"],
};

export const isWizardStep = (value: string | undefined): value is WizardStep => (wizardSteps as readonly string[]).includes(value ?? "");
export const isConfigureStep = (value: string): value is ConfigureStep => (configureSteps as readonly string[]).includes(value);
/** The steps a deployment shows: the plan step only when it bills workspaces. */
export const stepsFor = (billing: boolean): readonly WizardStep[] => billing ? wizardSteps : wizardSteps.filter((s) => s !== "plan");
export function nextStep(step: WizardStep, billing: boolean): WizardStep | undefined {
  const at = wizardSteps.indexOf(step);
  return stepsFor(billing).find((s) => wizardSteps.indexOf(s) > at);
}
export function previousStep(step: WizardStep, billing: boolean): WizardStep | undefined {
  const at = wizardSteps.indexOf(step);
  return step === "connect" ? undefined : [...stepsFor(billing)].reverse().find((s) => wizardSteps.indexOf(s) < at);
}

export type Onboarding = { startedAt: number; step?: string; reviewsPaused?: boolean; completedAt?: number; skipped?: boolean };
/** A workspace created with guided setup that has not finished (or skipped) it yet. */
export function needsSetup(organization: { onboarding?: Onboarding | null } | null | undefined) {
  return Boolean(organization?.onboarding?.startedAt && !organization.onboarding.completedAt);
}

export type SetupState = { hasWorkspace: boolean; connected: boolean; selected: number; indexingStarted: boolean; cursor?: string; completed: boolean; billing: boolean };
/** The step to show for a request: guards send users back to the first step they still need. */
export function resolveStep(requested: string | undefined, state: SetupState): WizardStep {
  if (!state.hasWorkspace) return "workspace";
  const ready = state.connected && state.selected > 0 && state.indexingStarted;
  if (requested === undefined) {
    if (!ready) return "connect";
    if (state.completed) return "connect";
    const after = isWizardStep(state.cursor) ? nextStep(state.cursor, state.billing) : undefined;
    return after && after !== "workspace" ? after : "indexing";
  }
  if (!isWizardStep(requested) || requested === "workspace") return "connect";
  if (requested !== "connect" && !ready) return "connect";
  if (requested === "plan" && !state.billing) return "done";
  return requested;
}

/** A configuration step's submitted values on top of the effective workspace defaults. */
export function stepSettingsFromForm<T extends { commentStyle: string; severityThreshold: string; minimumConfidence: number; maxComments: number; mode: string }>(step: ConfigureStep, form: FormData, base: T): T {
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const patch =
    step === "summary" ? { summarySections: form.getAll("summarySections").map(String), commentStyle: text("commentStyle") || base.commentStyle }
    : step === "comments" ? { severityThreshold: text("severityThreshold") || base.severityThreshold, minimumConfidence: Number(text("minimumConfidence") || base.minimumConfidence), maxComments: Number(text("maxComments") || base.maxComments), strictness: Number(text("strictness") || 0), categories: form.getAll("categories").map(String) }
    : step === "triggers" ? { automatic: form.has("automatic"), drafts: form.has("drafts"), rereview: form.has("rereview"), threadReplies: form.has("threadReplies"), triggerLabels: text("triggerLabels").split(",").map((s) => s.trim()).filter(Boolean) }
    : { securityScan: form.has("securityScan"), fixPullRequests: form.has("fixPullRequests"), mode: text("mode") || base.mode };
  return { ...base, ...patch };
}
