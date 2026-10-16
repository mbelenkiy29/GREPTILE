import type { Metadata } from "next";
import { AuthScreen, redirectIfSignedIn, type AuthQuery } from "../auth-screen";

export const metadata: Metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: Promise<AuthQuery> }) {
  const query = await searchParams;
  await redirectIfSignedIn(query.next);
  return <AuthScreen mode="login" query={query} />;
}
