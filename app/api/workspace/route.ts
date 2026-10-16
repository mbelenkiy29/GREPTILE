import { api } from "../../../convex/_generated/api";
import { apiIdentity, apiFailure } from "../../../src/api-auth";
import { backend } from "../../../src/server";

// The API key's workspace, the owner's other workspaces (each needs its own key) and the dashboard
// links CLI onboarding prints. Read scope; links are built from APP_URL, never from the request.
export async function GET(request: Request) {
  try {
    const { token, organizationId } = await apiIdentity(request);
    const me = await backend().query(api.users.me, { token });
    const workspaces = me.organizations.filter((o) => o._id).map((o) => ({ id: o._id!, name: o.name ?? "Workspace", role: o.role, current: o._id === organizationId }));
    const workspace = workspaces.find((w) => w.current);
    if (!workspace) return Response.json({ error: "Workspace not accessible" }, { status: 403 });
    const base = process.env.APP_URL ?? new URL(request.url).origin;
    const link = (path: string) => new URL(path, base).toString();
    return Response.json({
      workspace: { id: workspace.id, name: workspace.name, role: workspace.role },
      workspaces,
      installUrl: link(`/api/github/install?organization=${encodeURIComponent(workspace.id)}`),
      dashboardUrl: link("/dashboard"),
      keysUrl: link("/dashboard/settings/keys"),
      rulesUrl: link("/dashboard/memory/rules"),
    });
  } catch (error) {
    return apiFailure(error, { status: 401, error: "Unauthorized" });
  }
}
