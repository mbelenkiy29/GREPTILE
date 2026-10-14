export function GET() {
  return Response.json({
    status: "ok",
    service: "openreview",
    configured: !!process.env.NEXT_PUBLIC_CONVEX_URL,
  });
}
