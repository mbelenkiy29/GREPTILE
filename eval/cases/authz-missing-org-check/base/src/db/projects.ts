export interface Project {
  id: string;
  orgId: string;
  name: string;
  archived: boolean;
}

/** Projects of every organization; callers must scope reads to the caller's org. */
export interface ProjectStore {
  get(id: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
}
