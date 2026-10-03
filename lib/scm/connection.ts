/**
 * Resolves a GitLab / Bitbucket installation (its `external_id` is the `scm_credentials` id) to a live connection with
 * the decrypted token (R3.6). The token only ever lives in memory for the request that needs it.
 */
import { and, eq } from "drizzle-orm";
import type { BitbucketConnection } from "@/lib/bitbucket/client";
import { decryptSecret } from "@/lib/crypto";
import type { Db } from "@/lib/db";
import { scmCredentials } from "@/lib/db/schema";
import type { GitLabConnection } from "@/lib/gitlab/client";

export class ScmCredentialNotFoundError extends Error {
  constructor(provider: string, id: number) {
    super(`no ${provider} connection ${id}`);
    this.name = "ScmCredentialNotFoundError";
  }
}

async function credential(db: Db, provider: "gitlab" | "bitbucket", id: number) {
  const [row] = await db
    .select()
    .from(scmCredentials)
    .where(and(eq(scmCredentials.id, id), eq(scmCredentials.provider, provider)));
  if (!row) throw new ScmCredentialNotFoundError(provider, id);
  return row;
}

export async function gitlabConnection(db: Db, id: number): Promise<GitLabConnection> {
  const row = await credential(db, "gitlab", id);
  return { baseUrl: row.baseUrl, token: decryptSecret(row.tokenEnc) };
}

export async function bitbucketConnection(db: Db, id: number): Promise<BitbucketConnection> {
  const row = await credential(db, "bitbucket", id);
  return {
    apiUrl: row.baseUrl,
    workspace: row.workspace ?? "",
    token: decryptSecret(row.tokenEnc),
    ...(row.authKind === "app_password" && row.username ? { username: row.username } : {}),
  };
}
