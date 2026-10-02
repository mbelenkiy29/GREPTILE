import { Redis } from "ioredis";
import { env } from "@/lib/env";

let client: Redis | undefined;

export function redis(): Redis {
  client ??= new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return client;
}
