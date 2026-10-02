import { ClerkProvider, SignIn } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <ClerkProvider>
      <main className="shell" style={{ display: "grid", placeItems: "center", minHeight: "80vh" }}>
        <SignIn forceRedirectUrl="/dashboard" />
      </main>
    </ClerkProvider>
  );
}
