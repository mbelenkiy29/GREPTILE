import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorizationRequest, authorizationServerMetadata, bearerChallenge, clientMetadataUrl, isPrivateAddress, loadClientMetadata, parseClientMetadata, protectedResourceMetadata, s256, scopesForRole, validRedirectUri, validVerifier } from "../src/oauth-server";

const base = "https://review.example.com";

test("discovery documents: RFC 9728 resource metadata and RFC 8414 server metadata as MCP requires", () => {
  assert.deepEqual(protectedResourceMetadata(base), { resource: "https://review.example.com/api/mcp", authorization_servers: [base], scopes_supported: ["read"], bearer_methods_supported: ["header"], resource_name: "OpenReview MCP" });
  const as = authorizationServerMetadata(base);
  assert.equal(as.issuer, base, "issuer equals the identifier used to build the well-known URL");
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual([as.client_id_metadata_document_supported, as.authorization_response_iss_parameter_supported], [true, true]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(as.scopes_supported, ["read", "write", "admin"]);
  assert.equal(as.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(bearerChallenge(base), 'Bearer resource_metadata="https://review.example.com/.well-known/oauth-protected-resource/api/mcp", scope="read"');
  assert.equal(bearerChallenge(base, { error: "insufficient_scope", scope: "write", description: 'needs "write"' }), 'Bearer error="insufficient_scope", resource_metadata="https://review.example.com/.well-known/oauth-protected-resource/api/mcp", scope="write", error_description="needs write"');
});

test("authorization requests need PKCE S256, known scopes and a bounded state", () => {
  const ok = { response_type: "code", client_id: "https://app.example/client.json", redirect_uri: "http://127.0.0.1:8123/cb", code_challenge: s256("v".repeat(43)), code_challenge_method: "S256", state: "xyz" };
  assert.deepEqual(authorizationRequest.parse({ ...ok, scope: "read write read" }).scope, ["read", "write"]);
  assert.equal(authorizationRequest.parse(ok).scope, undefined);
  for (const bad of [{ code_challenge_method: "plain" }, { code_challenge_method: undefined }, { code_challenge: "short" }, { scope: "repo" }, { state: "x".repeat(501) }, { response_type: "token" }])
    assert.equal(authorizationRequest.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  assert.equal(s256("verifier"), createHash("sha256").update("verifier").digest("base64url"));
  assert.ok(validVerifier("a".repeat(43)) && !validVerifier("a".repeat(42)) && !validVerifier("a b".padEnd(50, "c")));
  assert.deepEqual(scopesForRole(["read", "write", "admin"], "viewer"), ["read"]);
  assert.deepEqual(scopesForRole(["read", "write", "admin"], "member"), ["read", "write"]);
  assert.deepEqual(scopesForRole(["read", "write", "admin"], "owner"), ["read", "write", "admin"]);
});

test("redirect URIs: HTTPS or loopback http, never fragments or credentials", () => {
  for (const ok of ["https://app.example/callback", "http://localhost:3000/cb", "http://127.0.0.1:53682/", "http://[::1]:9000/cb"]) assert.ok(validRedirectUri(ok), ok);
  for (const bad of ["http://app.example/cb", "https://app.example/cb#frag", "https://user:pw@app.example/cb", "javascript:alert(1)", "custom-scheme://cb", "not a url"]) assert.equal(validRedirectUri(bad), false, bad);
});

test("Client ID Metadata Documents: URL rules, private-address refusal and document validation", async () => {
  assert.ok(clientMetadataUrl("https://app.example/oauth/client.json"));
  for (const bad of ["http://app.example/client.json", "https://app.example/", "https://app.example", "https://127.0.0.1/c.json", "https://[::1]/c.json", "https://localhost/c.json", "https://db.internal/c.json", "https://app.example/c.json?x=1", "https://app.example/c.json#f", "https://u:p@app.example/c.json"]) assert.equal(clientMetadataUrl(bad), null, bad);
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip);
  const id = "https://app.example/oauth/client.json";
  const doc = { client_id: id, client_name: "Example MCP Client", redirect_uris: ["http://127.0.0.1:3000/callback"], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" };
  assert.deepEqual(parseClientMetadata(id, doc), { client: { clientId: id, name: "Example MCP Client", redirectUris: ["http://127.0.0.1:3000/callback"] } });
  assert.match(parseClientMetadata(id, { ...doc, client_id: "https://evil.example/client.json" }).error!, /does not match/);
  assert.match(parseClientMetadata(id, { ...doc, token_endpoint_auth_method: "client_secret_basic" }).error!, /public clients/);
  assert.match(parseClientMetadata(id, { ...doc, redirect_uris: ["http://evil.example/cb"] }).error!, /HTTPS or a loopback/);
  assert.match(parseClientMetadata(id, { client_id: id }).error!, /missing/);
  // Fetching: a fake fetcher stands in for the network.
  const fetched: string[] = [];
  const fake = (status: number, body: string, contentType = "application/json") => async (url: URL) => { fetched.push(url.toString()); return { status, contentType, body }; };
  assert.deepEqual((await loadClientMetadata(id, fake(200, JSON.stringify(doc)))), { client: { clientId: id, name: "Example MCP Client", redirectUris: ["http://127.0.0.1:3000/callback"] } });
  assert.match((await loadClientMetadata(id, fake(302, ""))).error!, /HTTP 302/);
  assert.match((await loadClientMetadata(id, fake(200, "<html>", "text/html"))).error!, /must be JSON/);
  assert.match((await loadClientMetadata(id, fake(200, "{ broken"))).error!, /not valid JSON/);
  assert.match((await loadClientMetadata(id, async () => { throw new Error("Client metadata host resolves to a private address"); })).error!, /private address/);
  const before = fetched.length;
  assert.match((await loadClientMetadata("https://169.254.169.254/latest/meta-data", fake(200, "{}"))).error!, /public host/);
  assert.equal(fetched.length, before, "refused URLs are never fetched");
});
