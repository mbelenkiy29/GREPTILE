import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** A Clerk organization. Every tenant-owned row references this id. */
export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
