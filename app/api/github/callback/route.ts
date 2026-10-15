import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { backend, current, origin, unseal } from "../../../../src/server";
import { Github } from "../../../../src/github";
import { installTarget, installerGithubId, defaultInstallReturn } from "../../../../src/github-install";

export async function GET(request: Request) {
  const { token, user, organizations } = await current();
  const jar = await cookies(),
    url = new URL(request.url);
  let returnTo = defaultInstallReturn;
  try {
    const setup = jar.get("openreview_github_setup")?.value,
      state = jar.get("openreview_install_state")?.value;
    jar.delete("openreview_install_state");
    if (!setup || !state)
      throw new Error(
        "Sign in again before installing the GitHub App (setup expires after ten minutes)",
      );
    const saved = await unseal(state),
      credentials = await unseal(setup);
    if (saved.state !== url.searchParams.get("state"))
      throw new Error("Installation state mismatch");
    const target = installTarget(saved, user._id, organizations);
    returnTo = target.returnTo;
    const installationId = z.coerce
      .number()
      .int()
      .positive()
      .parse(url.searchParams.get("installation_id"));
    const userGithub = new Github(z.string().parse(credentials.token));
    const installations = await userGithub.request(
      "/user/installations?per_page=100",
      z.object({
        installations: z.array(
          z.object({
            id: z.number(),
            account: z.object({ id: z.number(), login: z.string() }),
          }),
        ),
      }),
    );
    const installation = installations.installations.find(
      (i) => i.id === installationId,
    );
    if (!installation)
      throw new Error(
        "Installation is not accessible to the signed-in GitHub user",
      );
    const github = await Github.installation(installationId),
      repositories = await github.repositories();
    // Installs on the installer's own account need no per-repository admin check.
    if (installation.account.id !== installerGithubId(credentials, user.githubId)) {
      for (const repository of repositories) {
        const access = await userGithub.request(
          `/repos/${repository.full_name}`,
          z.object({ permissions: z.object({ admin: z.boolean() }) }),
        );
        if (!access.permissions.admin)
          throw new Error(
            "Connecting organization repositories requires GitHub repository admin access",
          );
      }
    }
    await backend().mutation(api.repositories.connect, {
      token,
      secret: process.env.SERVICE_SECRET ?? "",
      organizationId: target.organizationId as Id<"organizations">,
      installationId,
      account: installation.account.login,
      accountId: installation.account.id,
      repositories: repositories.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        ...(r.owner.type==="Organization"&&r.owner.id?{group:{externalId:String(r.owner.id),name:r.owner.login.slice(0,100)}}:{}),
      })),
    });
    jar.delete("openreview_github_setup");
    return NextResponse.redirect(`${origin()}${returnTo}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Installation failed";
    // Guided setup shows the failure in place; other callers keep the JSON error.
    if (returnTo.startsWith("/dashboard/onboarding/"))
      return NextResponse.redirect(`${origin()}${returnTo}?error=github-install&message=${encodeURIComponent(message.slice(0, 200))}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
