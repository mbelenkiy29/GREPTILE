import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtected = createRouteMatcher(["/dashboard(.*)", "/select-org(.*)", "/api/github/install", "/api/github/callback"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  // Webhooks and the health check authenticate on their own and must not depend on Clerk.
  matcher: ["/((?!_next|api/health|api/webhooks|.*\\.(?:css|js|png|jpg|svg|ico|woff2?)$).*)"],
};
