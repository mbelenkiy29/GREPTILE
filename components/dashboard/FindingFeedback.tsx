"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { StatusPill } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";
import type { FindingFeedbackView } from "@/lib/data/feedback";

type Result = { ok: true; feedbackId: number; finding: { status: string }; counts: { useful: number; not_useful: number } } | { ok: false; error: string };
type RetractResult = { ok: true; retracted: boolean; status?: string } | { ok: false; error: string };

export interface FindingFeedbackActions {
  give: (formData: FormData) => Promise<Result>;
  retract: (formData: FormData) => Promise<RetractResult>;
}

const STATUS_KINDS = [
  { kind: "resolved", label: "Resolved", help: "Fixed, or no longer applies." },
  { kind: "wont_fix", label: "Won't fix", help: "A real issue the team accepts for now." },
  { kind: "false_positive", label: "False positive", help: "Not a real issue. Teaches future reviews." },
] as const;

const STATUS_LABEL: Record<string, string> = { resolved: "Resolved", wont_fix: "Won't fix", false_positive: "False positive" };

/**
 * Feedback on one finding (R6.10): Useful / Not useful (showing the viewer's vote, click again to take it back), and a
 * menu to mark it resolved, won't fix, or a false positive with an optional note. Status and counts update in place.
 */
export function FindingFeedback({
  findingId,
  status: initialStatus,
  view,
  actions,
  canGive,
  showStatus = true,
}: {
  findingId: number;
  status: string;
  view: FindingFeedbackView;
  actions: FindingFeedbackActions;
  canGive: boolean;
  /** Show the status pill (off where the surrounding view already shows it). */
  showStatus?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState(initialStatus);
  const [vote, setVote] = useState(view.myVote);
  const [counts, setCounts] = useState({ useful: view.useful, notUseful: view.notUseful });
  const [mine, setMine] = useState(view.myStatus);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const uid = useId();

  function give(kind: string, note?: string) {
    const fd = new FormData();
    fd.set("findingId", String(findingId));
    fd.set("kind", kind);
    if (note?.trim()) fd.set("note", note.trim());
    startTransition(async () => {
      const res = await actions.give(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setStatus(res.finding.status);
      setCounts({ useful: res.counts.useful, notUseful: res.counts.not_useful });
      if (kind === "useful" || kind === "not_useful") setVote({ kind, feedbackId: res.feedbackId });
      else setMine((m) => [{ kind: kind as (typeof STATUS_KINDS)[number]["kind"], feedbackId: res.feedbackId, note: note?.trim() || null }, ...m.filter((x) => x.kind !== kind)]);
      setAnnounce(kind === "useful" ? "Marked useful." : kind === "not_useful" ? "Marked not useful." : `Marked ${STATUS_LABEL[kind]?.toLowerCase()}.`);
      if (detailsRef.current) detailsRef.current.open = false;
      router.refresh();
    });
  }

  function retract(feedbackId: number, what: string, after: () => void) {
    const fd = new FormData();
    fd.set("feedbackId", String(feedbackId));
    startTransition(async () => {
      const res = await actions.retract(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      if (res.status) setStatus(res.status);
      after();
      setAnnounce(`Removed your ${what} feedback.`);
      router.refresh();
    });
  }

  function onVote(kind: "useful" | "not_useful") {
    if (vote?.kind === kind) {
      const id = vote.feedbackId;
      retract(id, kind === "useful" ? "useful" : "not useful", () => {
        setVote(null);
        setCounts((c) => (kind === "useful" ? { ...c, useful: Math.max(0, c.useful - 1) } : { ...c, notUseful: Math.max(0, c.notUseful - 1) }));
      });
    } else give(kind);
  }

  return (
    <div className="feedback-bar" data-finding-feedback={findingId} aria-busy={pending || undefined}>
      {showStatus && <StatusPill kind="finding" value={status} />}
      {canGive ? (
        <>
          <button
            type="button"
            className={buttonClass("default", "sm")}
            aria-pressed={vote?.kind === "useful"}
            disabled={pending}
            onClick={() => onVote("useful")}
            title={vote?.kind === "useful" ? "You marked this useful. Click to undo." : "Mark useful"}
          >
            <Icon name="check" size={14} /> Useful <span className="tab-count">{counts.useful}</span>
          </button>
          <button
            type="button"
            className={buttonClass("default", "sm")}
            aria-pressed={vote?.kind === "not_useful"}
            disabled={pending}
            onClick={() => onVote("not_useful")}
            title={vote?.kind === "not_useful" ? "You marked this not useful. Click to undo." : "Mark not useful"}
          >
            <Icon name="x" size={14} /> Not useful <span className="tab-count">{counts.notUseful}</span>
          </button>
          <details className="menu popover" ref={detailsRef}>
            <summary className={buttonClass("ghost", "sm")}>
              Status <Icon name="chevron-down" size={14} />
            </summary>
            <form
              className="menu-panel stack-sm"
              data-align="end"
              style={{ padding: 12, minWidth: 260 }}
              aria-label="Set the finding's status"
              onSubmit={(ev) => {
                ev.preventDefault();
                const fd = new FormData(ev.currentTarget);
                give(String(fd.get("kind") ?? ""), String(fd.get("note") ?? ""));
              }}
            >
              <fieldset className="fieldset stack-sm">
                <legend className="field-label">Mark as</legend>
                {STATUS_KINDS.map((s, i) => (
                  <label key={s.kind} className="check">
                    <input type="radio" name="kind" value={s.kind} defaultChecked={i === 0} />
                    <span>
                      {s.label} <span className="dim">· {s.help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="field">
                <label className="field-label" htmlFor={`${uid}-note`}>
                  Note <span className="dim">(optional)</span>
                </label>
                <textarea id={`${uid}-note`} name="note" className="textarea" rows={2} maxLength={4000} placeholder="Why? Helps teammates and future reviews." />
              </div>
              <button type="submit" className={buttonClass("primary", "sm")} disabled={pending}>
                Save status
              </button>
              {mine.length > 0 && (
                <div className="stack-sm">
                  {mine.map((m) => (
                    <button
                      key={m.feedbackId}
                      type="button"
                      className={buttonClass("ghost", "sm")}
                      disabled={pending}
                      onClick={() => retract(m.feedbackId, STATUS_LABEL[m.kind] ?? m.kind, () => setMine((all) => all.filter((x) => x.feedbackId !== m.feedbackId)))}
                    >
                      Undo “{STATUS_LABEL[m.kind]}”
                    </button>
                  ))}
                </div>
              )}
            </form>
          </details>
        </>
      ) : (
        <span className="dim">
          {counts.useful} useful · {counts.notUseful} not useful
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
      {error && (
        <span className="error-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
