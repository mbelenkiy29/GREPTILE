/**
 * `pnpm eval` (R6.24): runs the documented bug fixtures in `eval/cases/` through the real indexer and review engine
 * and reports true positives, false positives, missed bugs, duplicates, precision / recall, latency, tokens, and
 * estimated cost. Options and modes are in `lib/eval/cli.ts` and `eval/README.md`. Reads `.env` when present.
 */
import { existsSync } from "node:fs";
import { evalMain } from "@/lib/eval/cli";

if (existsSync(".env")) process.loadEnvFile(".env");
// Progress goes to the console table; keep the engine's structured info logs out of it unless asked for.
process.env.LOG_LEVEL ??= "warn";

evalMain(process.argv.slice(2))
  .then(({ code }) => process.exit(code))
  .catch((err) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
