"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Icon } from "@/components/ui/icons";
import { menuItemProps } from "@/components/ui/menu";

/**
 * "Fix with AI" controls (R3.1, R6.19). Prompts are built server-side by the REST API (`/api/v1`, authenticated by
 * the dashboard session cookie) and fetched when the menu is first approached (hover, focus, or press), so pages
 * stay light and the copy action itself is synchronous (browsers only allow clipboard writes inside the click).
 */

const AGENTS = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
] as const;
type AgentId = (typeof AGENTS)[number]["id"];

interface FixPromptResponse {
  variants: Record<AgentId, string>;
  cursorDeepLink: string | null;
}

interface FixAllResponse {
  task: { markdown: string; findings: unknown[]; omitted: number; minConfidence: number; filename: string };
}

type Load<T> = { status: "idle" } | { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status}).`);
  return body as T;
}

/** Fetches `url` once, on demand. */
function useLazyJson<T>(url: string) {
  const [state, setState] = useState<Load<T>>({ status: "idle" });
  const started = useRef(false);
  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setState({ status: "loading" });
    getJson<T>(url).then(
      (data) => setState({ status: "ready", data }),
      (err: unknown) => {
        started.current = false;
        setState({ status: "error", message: err instanceof Error ? err.message : "Could not load the prompt." });
      },
    );
  }, [url]);
  return { state, load };
}

/** A short-lived status message, announced politely. */
function useFlash() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(""), 2500);
    return () => clearTimeout(t);
  }, [message]);
  return [message, setMessage] as const;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function Status({ message }: { message: string }) {
  return (
    <span className="dim" aria-live="polite" role="status" style={{ fontSize: "0.85em" }}>
      {message}
    </span>
  );
}

/** Per-finding menu: copy a fix prompt for Claude Code, Cursor, or Codex, or open it in Cursor. */
export function FixWithAiMenu({ findingId, compact = false }: { findingId: number; compact?: boolean }) {
  const { state, load } = useLazyJson<FixPromptResponse>(`/api/v1/findings/${findingId}/fix-prompt`);
  const [message, flash] = useFlash();
  const ready = state.status === "ready" ? state.data : null;
  const item = menuItemProps();
  return (
    <span className="row-tight" onPointerEnter={load} onFocusCapture={load} onPointerDownCapture={load} data-testid={`fix-with-ai-${findingId}`}>
      <DropdownMenu
        label="Fix with AI"
        align="end"
        className="row-menu"
        trigger={
          <>
            <Icon name="spark" size={14} />
            {!compact && <span>Fix with AI</span>}
            <Icon name="chevron-down" size={12} />
          </>
        }
      >
        {state.status === "error" && (
          <button {...item} type="button" onClick={load}>
            {state.message} Retry
          </button>
        )}
        {AGENTS.map((a) => (
          <button
            key={a.id}
            {...item}
            type="button"
            aria-disabled={ready ? undefined : true}
            onClick={async () => {
              if (!ready) return;
              flash((await copy(ready.variants[a.id])) ? `Prompt for ${a.label} copied` : "Couldn't copy; your browser blocked clipboard access");
            }}
          >
            <Icon name="copy" size={14} /> {ready ? `Copy prompt for ${a.label}` : state.status === "error" ? `Copy prompt for ${a.label}` : "Preparing prompt…"}
          </button>
        ))}
        {ready?.cursorDeepLink ? (
          <a {...item} href={ready.cursorDeepLink}>
            <Icon name="external" size={14} /> Open in Cursor
          </a>
        ) : (
          ready && (
            <button
              {...item}
              type="button"
              title="This prompt is too long for a Cursor link"
              onClick={async () => flash((await copy(ready.variants.cursor)) ? "Too long for a Cursor link: prompt copied, paste it into Cursor" : "Couldn't copy")}
            >
              <Icon name="copy" size={14} /> Open in Cursor (copy; too long for a link)
            </button>
          )
        )}
      </DropdownMenu>
      <Status message={message} />
    </span>
  );
}

/** Review-level "Fix all with AI": copy or download one task for every unresolved high-confidence finding. */
export function FixAllMenu({ reviewId }: { reviewId: number }) {
  const { state, load } = useLazyJson<FixAllResponse>(`/api/v1/reviews/${reviewId}/fix-all`);
  const [message, flash] = useFlash();
  const ready = state.status === "ready" ? state.data.task : null;
  const item = menuItemProps();
  const count = ready ? ready.findings.length : null;
  return (
    <span className="row-tight" onPointerEnter={load} onFocusCapture={load} onPointerDownCapture={load} data-testid="fix-all">
      <DropdownMenu
        label="Fix all with AI"
        align="end"
        trigger={
          <>
            <Icon name="spark" size={14} /> <span>Fix all with AI</span> <Icon name="chevron-down" size={12} />
          </>
        }
      >
        {state.status === "error" && (
          <button {...item} type="button" onClick={load}>
            {state.message} Retry
          </button>
        )}
        <button
          {...item}
          type="button"
          aria-disabled={ready && count ? undefined : true}
          onClick={async () => {
            if (!ready || !count) return;
            flash((await copy(ready.markdown)) ? `Task with ${count} finding${count === 1 ? "" : "s"} copied` : "Couldn't copy; try the download");
          }}
        >
          <Icon name="copy" size={14} />{" "}
          {ready ? (count ? `Copy task (${count} finding${count === 1 ? "" : "s"})` : `No open findings at ≥${Math.round(ready.minConfidence * 100)}% confidence`) : "Preparing task…"}
        </button>
        <a {...item} href={`/api/v1/reviews/${reviewId}/fix-all?format=md`} download={ready?.filename ?? true}>
          <Icon name="arrow-down" size={14} /> Download as Markdown
        </a>
      </DropdownMenu>
      <Status message={message} />
    </span>
  );
}
