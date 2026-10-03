/** The `openreview` executable (R3.5). */
import { nodeIo } from "./io";
import { run } from "./program";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`openreview needs Node.js 22 or newer (this is ${process.versions.node}).\n`);
  process.exit(2);
}

process.exitCode = await run(process.argv.slice(2), nodeIo());
