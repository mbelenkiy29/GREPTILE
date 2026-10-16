import { z } from "zod";
import { egressAllowed } from "./egress";

// Transactional email through Resend (https://resend.com/docs/api-reference/emails/send-email).
// Without RESEND_API_KEY and EMAIL_FROM every send is skipped, never an error.
export const emailAddress = z.string().trim().toLowerCase().max(254).email();
export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) && egressAllowed("email");
}
// The web app shows email sign-in and email invitations when Convex can send mail; the Resend key
// lives in Convex, so the web app needs EMAIL_SIGN_IN=true (or the same keys) to know.
export const emailOnWeb = () => (process.env.EMAIL_SIGN_IN === "true" || emailConfigured()) && egressAllowed("email");
export async function sendEmail(message: { to: string; subject: string; text: string }, fetchImpl: typeof fetch = fetch): Promise<{ id: string } | { skipped: string }> {
  if (!emailConfigured()) return { skipped: "Email delivery is not configured" };
  const to = emailAddress.parse(message.to);
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject: message.subject.replace(/[\r\n]+/g, " ").slice(0, 200), text: message.text.slice(0, 50000) }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (!response.ok || typeof data?.id !== "string") throw new Error(`Email provider returned HTTP ${response.status}`);
  return { id: data.id };
}
