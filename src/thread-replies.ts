// Replies without an @openreview mention are answered only in threads OpenReview started. Bare
// acknowledgements ("thanks", "fixed", 👍) get no answer, and commands still need the mention.
const acknowledgement = /^(?:(?:ok(?:ay)?|thanks?(?:\s+you)?|thx|ty|done|fixed|resolved|addressed|lgtm|nice|great|good catch|will do|makes sense|agreed?|sure|yes|no|got it|👍|🙏|✅|🎉)[\s.!,]*)+$/iu;
export function wantsAnswer(body: string) {
  const text = body.replace(/^>.*$/gm, "").trim();
  return text.length >= 2 && !acknowledgement.test(text);
}
export const threadReplyLimits = { perThread: 3, perPullRequest: 10, windowMs: 3_600_000 } as const;
