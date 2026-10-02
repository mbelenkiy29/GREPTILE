import { Redis } from "ioredis";
import { infraEnv } from "@/lib/env";

let client: Redis | undefined;

export function redis(): Redis {
  client ??= new Redis(infraEnv().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return client;
}
