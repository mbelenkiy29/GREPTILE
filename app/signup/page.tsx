import type { Metadata } from "next";
import { AuthScreen, redirectIfSignedIn, type AuthQuery } from "../auth-screen";

export const metadata: Metadata = { title: "Create your account" };

export default async function Signup({ searchParams }: { searchParams: Promise<AuthQuery> }) {
  const query = await searchParams;
  await redirectIfSignedIn(query.next);
  return <AuthScreen mode="signup" query={query} />;
}
