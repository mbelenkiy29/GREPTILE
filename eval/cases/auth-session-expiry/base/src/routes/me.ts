import { verifySession } from "../auth/session";

export interface Request {
  headers: Record<string, string | undefined>;
}

/** GET /me — the signed-in user's id, or 401. */
export function meRoute(secret: string) {
  return (req: Request) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const session = verifySession(token, secret);
    if (!session) return { status: 401, body: { error: "sign in" } };
    return { status: 200, body: { userId: session.userId } };
  };
}
