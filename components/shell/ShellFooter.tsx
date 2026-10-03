import { Icon } from "@/components/ui/icons";

/**
 * Footer of the signed-in shell: the running version and a link to its source code (AGPL-3.0 §13 — users interacting
 * with the service over a network can get the corresponding source).
 */
export function ShellFooter({ sourceUrl, version }: { sourceUrl: string; version: string }) {
  return (
    <div className="shell-footer" data-testid="shell-footer">
      <a href={sourceUrl} target="_blank" rel="noreferrer" data-source-link="">
        <Icon name="source" size={12} /> Source
      </a>
      <span aria-hidden="true">·</span>
      <span className="mono" title="Running version">
        v{version}
      </span>
      <span aria-hidden="true">·</span>
      <span>AGPL-3.0</span>
    </div>
  );
}
