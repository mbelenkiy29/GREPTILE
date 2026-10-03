/**
 * `@openreview` mentions (R1.7) are answered by the conversations module (R6.17); this module keeps the original
 * import path working.
 */
export { MENTION_MARKER, answerMention, stripMention } from "@/lib/conversations";
