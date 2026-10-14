import test from "node:test";
import assert from "node:assert/strict";
import { repositorySourceUrl } from "../src/source-url";

test("source links retain native providers, pinned revisions and encoded paths without unsafe targets", () => {
  const revision = "a".repeat(40), path = "src/price #?.ts", encoded = "src/price%20%23%3F.ts";
  const link = (kind: string, instance = "https://code.example/base") => repositorySourceUrl(kind, instance, "acme/payments", revision, path);
  assert.equal(link("github", "https://github.com"), `https://github.com/acme/payments/blob/${revision}/${encoded}`);
  assert.equal(link("github-enterprise"), `https://code.example/base/acme/payments/blob/${revision}/${encoded}`);
  assert.equal(link("gitlab"), `https://code.example/base/acme/payments/-/blob/${revision}/${encoded}`);
  assert.equal(link("gitea"), `https://code.example/base/acme/payments/src/commit/${revision}/${encoded}`);
  assert.equal(link("bitbucket-cloud"), `https://bitbucket.org/acme/payments/src/${revision}/${encoded}`);
  assert.equal(link("bitbucket-dc"), `https://code.example/base/projects/acme/repos/payments/browse/${encoded}?at=${revision}`);
  assert.equal(repositorySourceUrl("origin", "https://api.cursor.com/v1/origin", "acme/renamed", "native revision", path, "repo_opaque"), `https://cursor.com/codebase/acme/renamed/blob/native%20revision/${encoded}`);
  for (const file of ["../secret", "/secret", "src/../secret", "src//file", "src\\file", "src/\nfile"]) assert.throws(() => repositorySourceUrl("github", "https://github.com", "acme/payments", revision, file));
  for (const instance of ["javascript:alert(1)", "http://code.example", "https://token@code.example", "https://code.example/?token=x", "https://code.example/#fragment"]) assert.throws(() => link("gitlab", instance));
  assert.throws(() => repositorySourceUrl("github", "https://github.com", "acme/../other", revision, path));
  assert.throws(() => repositorySourceUrl("github", "https://github.com", "acme/payments", "", path));
  assert.throws(() => link("perforce"));
});

test('GitHub adapter emits web source links for dedicated Cloud and keeps api-prefixed Server hostnames',async()=>{
 const {Github}=await import('../src/github'),revision='a'.repeat(40);
 assert.equal(new Github('fixture','https://api.tenant.ghe.com').sourceUrl('acme/repo',revision,'src/a.ts'),`https://tenant.ghe.com/acme/repo/blob/${revision}/src/a.ts`);
 assert.equal(new Github('fixture','https://api.server.fixture/api/v3').sourceUrl('acme/repo',revision,'src/a.ts'),`https://api.server.fixture/acme/repo/blob/${revision}/src/a.ts`);
});
