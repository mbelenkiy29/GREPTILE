import { label } from "../users/format";
import type { User } from "../users/types";

/** The notification text when `author` mentions someone in a comment. */
export function mentionText(author: User, comment: string): string {
  return `${label(author)} mentioned you: ${comment.slice(0, 140)}`;
}
