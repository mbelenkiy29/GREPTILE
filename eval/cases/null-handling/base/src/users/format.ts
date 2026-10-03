import type { User } from "./types";

/** The name shown for a user: their display name, or their email when they have none. */
export function label(user: User): string {
  return user.displayName ?? user.email;
}
