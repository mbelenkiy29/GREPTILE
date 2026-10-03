import Link from "next/link";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Icon } from "@/components/ui/icons";
import { menuItemProps } from "@/components/ui/menu";

type Action = (formData: FormData) => Promise<void>;

/**
 * Per-repository controls (R6.13): open settings, and for admins a menu to pause/resume reviews, re-index
 * (incremental or full), cancel a running index, and view knowledge. Every item is a server action or a link.
 */
export function RepoActions({
  repo,
  canManage,
  returnTo,
  actions,
}: {
  repo: { id: number; fullName: string; enabled: boolean; archived: boolean; indexJob: { id: number } | null };
  canManage: boolean;
  returnTo: string;
  actions: { toggle: Action; reindex: Action; cancelIndex: Action };
}) {
  const hidden = (
    <>
      <input type="hidden" name="repoId" value={repo.id} />
      <input type="hidden" name="returnTo" value={returnTo} />
    </>
  );
  return (
    <>
      <Link className="button button-sm" href={`/dashboard/repos/${repo.id}?tab=settings`}>
        Settings
      </Link>
      <DropdownMenu
        align="end"
        label={`More actions for ${repo.fullName}`}
        trigger={<Icon name="chevron-down" size={16} />}
        className="row-menu"
      >
        {canManage && !repo.archived && (
          <form action={actions.toggle} role="none">
            {hidden}
            <input type="hidden" name="enabled" value={String(!repo.enabled)} />
            <button {...menuItemProps()} type="submit">
              {repo.enabled ? "Pause reviews" : "Resume reviews"}
              <Icon name={repo.enabled ? "pause" : "play"} size={14} />
            </button>
          </form>
        )}
        {canManage && (
          <>
            <form action={actions.reindex} role="none">
              {hidden}
              <input type="hidden" name="kind" value="incremental" />
              <button {...menuItemProps()} type="submit">
                Re-index changes
                <Icon name="refresh" size={14} />
              </button>
            </form>
            <form action={actions.reindex} role="none">
              {hidden}
              <input type="hidden" name="kind" value="full" />
              <button {...menuItemProps()} type="submit">
                Full re-index
                <Icon name="refresh" size={14} />
              </button>
            </form>
          </>
        )}
        {canManage && repo.indexJob && (
          <form action={actions.cancelIndex} role="none">
            {hidden}
            <input type="hidden" name="jobId" value={repo.indexJob.id} />
            <button {...menuItemProps("menu-item")} type="submit">
              Cancel indexing
              <Icon name="stop" size={14} />
            </button>
          </form>
        )}
        {canManage && <div className="menu-sep" role="separator" />}
        <Link {...menuItemProps()} href={`/dashboard/repos/${repo.id}`}>
          Overview
          <Icon name="repo" size={14} />
        </Link>
        <Link {...menuItemProps()} href={`/dashboard/knowledge?repo=${repo.id}`}>
          View knowledge
          <Icon name="knowledge" size={14} />
        </Link>
      </DropdownMenu>
    </>
  );
}
