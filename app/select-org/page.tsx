import { ClerkProvider, OrganizationList } from "@clerk/nextjs";

export const dynamic = "force-dynamic";

export default function SelectOrgPage() {
  return (
    <ClerkProvider>
      <main className="shell" style={{ display: "grid", placeItems: "center", minHeight: "80vh" }}>
        <OrganizationList hidePersonal afterSelectOrganizationUrl="/dashboard" afterCreateOrganizationUrl="/dashboard" />
      </main>
    </ClerkProvider>
  );
}
