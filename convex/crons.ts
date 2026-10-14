import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval("Recover PR catalog imports",{minutes:1},internal.pullCatalogs.recover,{});
crons.interval("Recover durable P4 review polling",{minutes:1},internal.p4Polling.recover,{});
crons.interval("Recheck and invalidate automatic approvals",{minutes:5},internal.approvals.sweep,{});
crons.interval("Recover runtime worker jobs",{minutes:1},internal.runtime.recover,{});
crons.interval("Poll reactions on OpenReview comments",{minutes:60},internal.reactionJobs.sweep,{});
crons.interval(
  "Recover interrupted background work",
  { minutes: 5 },
  internal.recovery.sweep,
  {},
);
export default crons;
