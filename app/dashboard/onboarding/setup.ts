import { cookies } from "next/headers";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { backend, current } from "../../../src/server";
import type { SetupState } from "../../../src/onboarding-steps";
import { activeWorkspace } from "../load";

/** The signed-in user, active workspace, setup status and the state the step guards use. */
export async function loadSetup() {
  const user = await current(), organization = activeWorkspace(user, await cookies());
  if (!organization?._id) return { user, organization: null, status: null, state: { hasWorkspace: false, connected: false, selected: 0, indexingStarted: false, completed: false } satisfies SetupState };
  const organizationId = organization._id as Id<"organizations">;
  const status = await backend().query(api.onboarding.status, { token: user.token, organizationId });
  const selected = status.repositories.filter((r) => r.selected);
  const state: SetupState = {
    hasWorkspace: true,
    connected: status.connections.github.length + status.connections.providers.length > 0,
    selected: selected.length,
    indexingStarted: selected.some((r) => r.enabled || r.nativeIndex),
    cursor: status.onboarding?.step,
    // Workspaces from before guided setup have no record: treat them as set up (setup reopened).
    completed: !status.onboarding || Boolean(status.onboarding.completedAt),
  };
  return { user, organization: { ...organization, _id: organizationId }, status, state };
}
