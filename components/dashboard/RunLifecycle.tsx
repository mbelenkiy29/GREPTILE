import { Timeline } from "@/components/ui/Timeline";
import { runLifecycle, type LifecycleRun } from "@/lib/data/lifecycle";
import { formatDuration } from "@/lib/ui/format";

/** A review run's lifecycle (R6.6) as a stepper: each stage's state and timing; why a run failed or stopped. */
export function RunLifecycle({ run, now = new Date(), label = "Review run lifecycle" }: { run: LifecycleRun; now?: Date; label?: string }) {
  const steps = runLifecycle(run, now);
  return (
    <Timeline
      label={label}
      items={steps.map((s) => ({
        key: s.stage,
        label: s.label,
        state: s.state,
        meta:
          s.state === "skipped"
            ? "skipped"
            : s.durationMs !== null
              ? formatDuration(s.durationMs)
              : s.startedAt
                ? s.startedAt.toISOString().slice(11, 19) + " UTC"
                : null,
        detail: s.detail,
      }))}
    />
  );
}
