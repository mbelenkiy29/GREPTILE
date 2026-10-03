import type { Account, Db, Member } from "./client.js";

export function findAccount(db: Db, accountId: string): Account | null {
  return db.accounts.get(accountId) ?? null;
}

export function membershipOf(db: Db, accountId: string, userId: string): Member | null {
  return db.members.find((m) => m.accountId === accountId && m.userId === userId) ?? null;
}

export function listMembers(db: Db, accountId: string): Member[] {
  return db.members.filter((m) => m.accountId === accountId);
}
