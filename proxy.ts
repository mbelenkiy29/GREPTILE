import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtected = createRouteMatcher(["/dashboard(.*)", "/select-org(.*)", "/api/github/install", "/api/github/callback"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  // Only routes that use Clerk. Public pages, webhooks, and the health check never depend on it.
  matcher: ["/dashboard/:path*", "/select-org/:path*", "/sign-in/:path*", "/api/github/:path*"],
};
