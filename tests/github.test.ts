import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8 } from "jose";
import { createHmac } from "node:crypto";
import { Github, verifyWebhook } from "../src/github";
test("runtime archives use exact revisions, restrict redirects, and never forward installation credentials to codeload",async t=>{
 let malicious=false;
 t.mock.method(globalThis,"fetch",async(input:string|URL,options:RequestInit)=>{
  const url=String(input);
  if(url.startsWith("https://api.github.com/")){assert.ok(url.endsWith("/tarball/"+"a".repeat(40)));return new Response(null,{status:302,headers:{location:malicious?"https://untrusted.example/source":"https://codeload.github.com/owner/repo/tar.gz/"+"a".repeat(40)}});}
  assert.ok(url.startsWith("https://codeload.github.com/"));assert.equal(new Headers(options.headers).get("authorization"),null);return new Response("exact archive");
 });
 const github=new Github("installation-fixture");
 assert.equal(new TextDecoder().decode(await github.archive("owner/repo","a".repeat(40))),"exact archive");
 malicious=true;await assert.rejects(github.archive("owner/repo","a".repeat(40)),/unauthorized host/);
 await assert.rejects(github.archive("owner/repo","main"),/exact Git commit/);
});
test("webhook signature verifies exact bytes, rejects missing/malformed signatures and modified payloads", () => {
  const body = '{"action":"opened"}',
    secret = "webhook-test-secret";
  const signature =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.ok(verifyWebhook(body, signature, secret));
  assert.equal(verifyWebhook(body + " ", signature, secret), false);
  assert.equal(verifyWebhook(body, signature, "different"), false);
  assert.equal(verifyWebhook(body, null, secret), false);
  assert.equal(verifyWebhook(body, "sha256=xx", secret), false);
  assert.equal(verifyWebhook(body, signature, ""), false);
});

test("branch inventory validates provider data and reports its browsing ceiling", async () => {
  const original = globalThis.fetch;
  let limited = true;
  const pages: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    const size = limited ? (page === 3 ? 1 : 100) : 1;
    return Response.json(
      Array.from({ length: size }, (_, index) => ({
        name: `branch-${page}-${index}`,
        commit: { sha: "a".repeat(40) },
        protected: false,
      })),
    );
  };
  try {
    const github = new Github("test-only");
    const result = await github.branches("test/fixture");
    assert.equal(result.branches.length, 200);
    assert.equal(result.limited, true);
    assert.deepEqual(pages, [1, 2, 3]);
    limited = false;
    assert.equal((await github.branches("test/fixture")).limited, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("installation token validates least-privilege contents, PR, issue-webhook and check access", async (t) => {
  const originalId = process.env.GITHUB_APP_ID,
    originalKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_PRIVATE_KEY = await exportPKCS8(privateKey);
  const permissions = {
    contents: "read",
    pull_requests: "write",
    issues: "read",
    checks: "read",
  };
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ token: "test-only-token", permissions }),
  );
  try {
    assert.ok(await Github.installation(1));
    permissions.issues = "none";
    await assert.rejects(Github.installation(1), /issues:read/);
    permissions.issues = "read";
    permissions.contents = "none";
    await assert.rejects(Github.installation(1), /contents:read/);
  } finally {
    if (originalId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = originalId;
    if (originalKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = originalKey;
  }
});

test("carried findings retain Fix All without posting duplicate inline comments",async t=>{
 const previous=process.env.APP_URL;process.env.APP_URL="https://review.example.com";
 const sha="a".repeat(40);let posted:{body:string;comments:unknown[]}|undefined;
 t.mock.method(globalThis,"fetch",async(input:string|URL,options?:RequestInit)=>{
  const url=new URL(String(input));
  if(options?.method==="POST"){
   posted=JSON.parse(String(options.body));
   return Response.json({id:9,commit_id:sha,user:{login:"test-bot[bot]"}});
  }
  if(url.pathname.endsWith("/reviews")||url.pathname.endsWith("/comments"))return Response.json([]);
  return Response.json({head:{sha},state:"open"});
 });
 try{
  const github=new Github("fixture","https://api.github.com",async()=>"test-bot");
  await github.publish("owner/repo",1,sha,"A verified finding remains open.",[],"latest-review","detailed",undefined,1);
  assert.ok(posted);assert.deepEqual(posted.comments,[]);
  assert.match(posted.body,/\[Fix All\]\(https:\/\/review.example.com\/fix\/latest-review\)/);
  assert.equal((posted.body.match(/View review \/ Re-review/g)??[]).length,1);
  await github.publish("owner/repo",1,sha,"No unresolved findings.",[],"clean-review","detailed",undefined,0);
  assert.ok(!posted.body.includes("[Fix All]"));
 }finally{if(previous===undefined)delete process.env.APP_URL;else process.env.APP_URL=previous;}
});
