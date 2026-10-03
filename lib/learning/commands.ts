/**
 * Recognizing comments addressed to OpenReview and the explicit feedback commands people write in them (R6.10,
 * R6.17). A comment is addressed to the bot when it mentions `@<bot>` or starts with `/<bot>` (e.g. `/openreview`).
 */

export type FeedbackCommand = "resolved" | "wont_fix" | "false_positive" | "useful" | "not_useful" | "ignore_pattern";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the comment mentions `@bot` (not as part of a longer name or an email-like token). */
export function mentionsBot(body: string, bot: string): boolean {
  return new RegExp(`(^|[^\\w/@-])@${escapeRe(bot)}(?![\\w-])`, "i").test(body);
}

/** True when the comment starts with the `/bot` slash-command prefix (after leading whitespace or a quote). */
export function hasSlashPrefix(body: string, bot: string): boolean {
  return new RegExp(`^\\s*/${escapeRe(bot)}(?![\\w-])`, "i").test(body);
}

/** A comment written to OpenReview: a mention or a `/openreview` command. */
export function addressesBot(body: string, bot: string): boolean {
  return mentionsBot(body, bot) || hasSlashPrefix(body, bot);
}

/** The comment with the mention and any leading `/bot` prefix removed, whitespace collapsed. */
export function stripAddress(body: string, bot: string): string {
  const name = escapeRe(bot);
  return body
    .replace(new RegExp(`^\\s*/${name}(?![\\w-])`, "i"), "")
    .replace(new RegExp(`@${name}(?![\\w-])`, "gi"), "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const COMMANDS: [RegExp, FeedbackCommand][] = [
  [/^(?:please )?(?:mark (?:this |it )?(?:as )?)?resolved?$/, "resolved"],
  [/^(?:please )?(?:mark (?:this |it )?(?:as )?)?(?:won'?t ?fix|wontfix|will not fix)$/, "wont_fix"],
  [/^(?:please )?(?:mark (?:this |it )?(?:as )?)?(?:a )?false[- ]?positive$/, "false_positive"],
  [/^(?:please )?(?:mark (?:this |it )?(?:as )?)?not (?:useful|helpful)$/, "not_useful"],
  [/^(?:please )?(?:mark (?:this |it )?(?:as )?)?(?:useful|helpful)$/, "useful"],
  [/^(?:please )?ignore (?:this|that|these) (?:pattern|kind of (?:finding|comment|issue)s?|type of (?:finding|comment|issue)s?)$/, "ignore_pattern"],
  [/^ignore[- ]pattern$/, "ignore_pattern"],
];

/**
 * The explicit feedback command in a comment addressed to the bot, or null. The command must be the whole message
 * (trailing punctuation allowed), so a sentence that merely contains "resolved" is not a command.
 */
export function parseFeedbackCommand(body: string, bot: string): FeedbackCommand | null {
  if (!addressesBot(body, bot)) return null;
  const text = stripAddress(body, bot)
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[\s.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, cmd] of COMMANDS) if (re.test(text)) return cmd;
  return null;
}

/** GitHub `author_association` values that come with write access to the repository. */
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Whether a commenter may run commands that change state (re-review, ignore pattern, mark resolved, ...). */
export function canRunCommands(authorAssociation: string | null | undefined): boolean {
  return Boolean(authorAssociation && WRITERS.has(authorAssociation.toUpperCase()));
}
