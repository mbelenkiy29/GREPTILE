import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed server env. Throws with a readable message if a required variable is missing. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
