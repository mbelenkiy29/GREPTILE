// PostHog is downloaded only for visitors who accept analytics. Everything that starts, stops or
// identifies it goes through this loader, which imports src/analytics.ts (and PostHog with it) on
// first use, so the library stays out of the JavaScript every page loads.
type Analytics = typeof import("./analytics");
let loading: Promise<Analytics> | undefined;

/** Loads analytics on first use, then returns the same module. Call only after consent. */
export const loadAnalytics = () => (loading ??= import("./analytics"));

/** Runs `use` if analytics was already loaded in this page; never downloads it. */
export function withLoadedAnalytics(use: (analytics: Analytics) => void) {
  void loading?.then(use);
}
