"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { solveChallenge } from "@/lib/demo/pow-solver";
import { parsePrUrl } from "@/lib/demo/url";

type Phase = { kind: "idle" } | { kind: "verifying"; tried: number } | { kind: "submitting" } | { kind: "error"; message: string };

const isChallenge = (v: unknown): v is { token: string; difficulty: number } =>
  !!v && typeof v === "object" && typeof (v as { token?: unknown }).token === "string" && typeof (v as { difficulty?: unknown }).difficulty === "number";

async function errorFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
  } catch {
    // fall through
  }
  return "Something went wrong. Try again.";
}

/**
 * The "Paste a PR" form (R3.7): checks the URL, fetches a proof-of-work challenge, solves it in the browser with
 * SubtleCrypto (a few seconds of hashing instead of a third-party captcha), and submits.
 */
export function TryForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = phase.kind === "verifying" || phase.kind === "submitting";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const parsed = parsePrUrl(url);
    if (!parsed.ok) {
      setFieldError(parsed.error);
      return;
    }
    setFieldError(null);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      setPhase({ kind: "verifying", tried: 0 });
      const challengeRes = await fetch("/api/demo/challenge", { method: "POST", signal: controller.signal });
      if (!challengeRes.ok) throw new Error(await errorFrom(challengeRes));
      const challenge: unknown = await challengeRes.json();
      if (!isChallenge(challenge)) throw new Error("Something went wrong. Try again.");
      const solution = await solveChallenge(challenge.token, challenge.difficulty, {
        signal: controller.signal,
        onProgress: (tried) => setPhase({ kind: "verifying", tried }),
      });
      setPhase({ kind: "submitting" });
      const res = await fetch("/api/demo/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), challenge: challenge.token, solution }),
        signal: controller.signal,
      });
      if (res.status !== 202) throw new Error(await errorFrom(res));
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.id)) throw new Error("Something went wrong. Try again.");
      router.push(`/try/${body.id}`);
    } catch (err) {
      if (controller.signal.aborted) return;
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong. Try again." });
    }
  }

  return (
    <form className="stack-md" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label className="field-label" htmlFor="pr-url">
          Public pull request URL
        </label>
        <input
          id="pr-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repo/pull/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? "pr-url-error" : "pr-url-help"}
          disabled={busy}
          required
        />
        {fieldError ? (
          <span id="pr-url-error" className="field-error">
            {fieldError}
          </span>
        ) : (
          <span id="pr-url-help" className="field-help">
            Any open or closed pull request in a public github.com repository. No sign-in needed.
          </span>
        )}
      </div>
      {phase.kind === "error" && <Alert tone="error">{phase.message}</Alert>}
      <button className="button button-primary button-lg" type="submit" disabled={busy} aria-busy={busy}>
        {phase.kind === "verifying" ? "Checking your browser…" : phase.kind === "submitting" ? "Queuing the review…" : "Review this pull request"}
      </button>
      {phase.kind === "verifying" && (
        <p className="dim" role="status">
          Your browser is solving a small puzzle so the demo stays available for everyone ({phase.tried.toLocaleString("en-US")} hashes so far).
        </p>
      )}
    </form>
  );
}
