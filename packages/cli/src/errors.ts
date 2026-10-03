/** Exit codes: 0 success, 1 a finding at or above `--fail-on`, 2 an error (usage, auth, network, model, git). */
export const EXIT = { ok: 0, findings: 1, error: 2 } as const;

/** An error with a message written for the person at the terminal; never carries a token. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode: number = EXIT.error,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Removes anything that looks like an OpenReview API key or device code from text shown to the user. */
export function scrubSecrets(text: string): string {
  return text.replace(/or_live_[A-Za-z0-9_-]+/g, "or_live_…").replace(/ordc_[A-Za-z0-9_-]+/g, "ordc_…");
}
