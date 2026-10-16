import { loadEnvFile } from "node:process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

// Operator statistics across workspaces. Only workspaces whose admins chose "aggregate" data sharing
// are included, and only counts are returned (no code, titles or text).
try { loadEnvFile(".env.local"); } catch { /* environment only */ }
const url = process.env.NEXT_PUBLIC_CONVEX_URL, secret = process.env.SERVICE_SECRET;
if (!url || !secret) throw new Error("Set NEXT_PUBLIC_CONVEX_URL and SERVICE_SECRET");
console.log(JSON.stringify(await new ConvexHttpClient(url).query(api.dataControls.aggregateReport, { secret }), null, 2));
