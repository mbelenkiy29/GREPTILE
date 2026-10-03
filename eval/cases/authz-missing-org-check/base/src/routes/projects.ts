import type { ProjectStore } from "../db/projects";

export interface Caller {
  userId: string;
  orgId: string;
}

export class NotFoundError extends Error {}

/** GET /projects/:id — only projects of the caller's organization are visible. */
export async function getProject(store: ProjectStore, caller: Caller, id: string) {
  const project = await store.get(id);
  if (!project || project.orgId !== caller.orgId) throw new NotFoundError(id);
  return project;
}

/** PATCH /projects/:id — renames a project of the caller's organization. */
export async function renameProject(store: ProjectStore, caller: Caller, id: string, name: string) {
  const project = await getProject(store, caller, id);
  project.name = name.trim();
  await store.save(project);
  return project;
}
