import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { promisify } from "node:util";
import { caCertificates, connectionNetwork, dispatcherFor, proxyOrigin, scmFetch, scmNetwork } from "../src/scm-transport";
import { Gitlab } from "../src/gitlab";
import { authenticatedProviderIdentity } from "../src/provider-identity";

const publicRoot = rootCertificates[0];
function environment(t: TestContext, values: Record<string, string | undefined>) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  t.after(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
}
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
type Call = { url: string; init: RequestInit };
function fakeFetch(routes: (url: URL, init: RequestInit) => Response) {
  const calls: Call[] = [];
  return { calls, fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return routes(new URL(url), init); } };
}

test("network settings: API URL obeys the host allowlist, proxies need SCM_ALLOWED_PROXIES, CA bundles hold only valid certificates", (t) => {
  environment(t, { SCM_ALLOWED_HOSTS: "gitlab.example.com,gitlab-api.internal:8443", SCM_ALLOWED_PROXIES: "proxy.internal:3128" });
  assert.deepEqual(scmNetwork({ apiUrl: "https://gitlab-api.internal:8443/", proxyUrl: "http://proxy.internal:3128", caBundle: `\n${publicRoot}\n` }, ["gitlab.com"]), { apiUrl: "https://gitlab-api.internal:8443", proxyUrl: "http://proxy.internal:3128", caBundle: publicRoot.trim() });
  assert.deepEqual(scmNetwork({ apiUrl: "", caBundle: " ", proxyUrl: "" }), {}, "empty fields mean no settings");
  assert.throws(() => scmNetwork({ apiUrl: "https://evil.example" }), /SCM_ALLOWED_HOSTS/);
  assert.throws(() => scmNetwork({ apiUrl: "http://gitlab-api.internal:8443" }), /HTTPS/);
  assert.throws(() => proxyOrigin("http://other-proxy:3128"), /SCM_ALLOWED_PROXIES/);
  assert.throws(() => proxyOrigin("http://user:secret@proxy.internal:3128"), /without credentials/);
  assert.throws(() => proxyOrigin("http://proxy.internal:3128/path"), /without credentials or a path/);
  assert.throws(() => proxyOrigin("socks5://proxy.internal:3128"), /http\(s\)/);
  assert.throws(() => caCertificates(publicRoot + "\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"), /only PEM certificates/);
  assert.throws(() => caCertificates("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"), /could not be parsed/);
  assert.throws(() => caCertificates(publicRoot, Date.parse("2200-01-01")), /has expired/);
  assert.throws(() => caCertificates(Array(21).fill(publicRoot).join("\n")), /more than 20/);
  assert.deepEqual(connectionNetwork({ kind: "gitea", apiUrl: "https://evil.example" }), {}, "only GitLab connections use network settings");
  assert.throws(() => connectionNetwork({ kind: "gitlab", proxyUrl: "http://other-proxy:3128" }), /SCM_ALLOWED_PROXIES/, "stored settings are checked again when used");
});

test("CA and proxy plumbing: custom CAs are added to the public roots and reach the agent or the proxy's tunnel", () => {
  const agents: unknown[] = [], proxies: unknown[] = [];
  const deps = { agent: (o: unknown) => { agents.push(o); return {} as never; }, proxy: (o: unknown) => { proxies.push(o); return {} as never; } };
  assert.equal(dispatcherFor({}, deps), undefined, "no settings: the default fetch and trust store");
  dispatcherFor({ caBundle: publicRoot }, deps);
  const ca = (agents[0] as { connect: { ca: string[] } }).connect.ca;
  assert.deepEqual([ca.length, ca.at(-1), ca.slice(0, -1)], [rootCertificates.length + 1, publicRoot.trim(), [...rootCertificates]]);
  dispatcherFor({ proxyUrl: "http://proxy.internal:3128", caBundle: publicRoot }, deps);
  const proxy = proxies[0] as { uri: string; requestTls: { ca: string[] }; proxyTls: { ca: string[] } };
  assert.deepEqual([proxy.uri, proxy.requestTls.ca.at(-1), proxy.proxyTls.ca.at(-1)], ["http://proxy.internal:3128", publicRoot.trim(), publicRoot.trim()]);
  dispatcherFor({ proxyUrl: "http://proxy.internal:3128" }, deps);
  assert.deepEqual(proxies[1], { uri: "http://proxy.internal:3128" });
});

test("redirects: same-origin GETs are followed with the token; other hosts and repeated writes are refused", async () => {
  const fake = fakeFetch((url) => {
    if (url.pathname === "/api/v4/projects/old") return new Response(null, { status: 301, headers: { location: "/api/v4/projects/new" } });
    if (url.pathname === "/api/v4/projects/new") return Response.json({ id: 1 });
    if (url.pathname === "/api/v4/projects/away") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/api/v4/projects/1" } });
    if (url.pathname === "/api/v4/projects/port") return new Response(null, { status: 307, headers: { location: "https://gitlab.internal:8443/api/v4/projects/1" } });
    if (url.pathname === "/api/v4/projects/loop") return new Response(null, { status: 302, headers: { location: "/api/v4/projects/loop" } });
    if (url.pathname === "/api/v4/projects/write") return new Response(null, { status: 307, headers: { location: "/api/v4/projects/new" } });
    const chain = /^\/api\/v4\/chain(\d)\/(\d)$/.exec(url.pathname);
    if (chain) return Number(chain[2]) < Number(chain[1]) ? new Response(null, { status: 302, headers: { location: `/api/v4/chain${chain[1]}/${Number(chain[2]) + 1}` } }) : Response.json({ hops: Number(chain[2]) });
    return new Response(null, { status: 404 });
  });
  const send = scmFetch({}, { fetch: fake.fetch }), headers = { "PRIVATE-TOKEN": "fixture-token" };
  assert.deepEqual(await (await send("https://gitlab.internal/api/v4/projects/old", { headers })).json(), { id: 1 });
  assert.deepEqual(fake.calls.map((c) => [c.url, c.init.redirect, (c.init.headers as Record<string, string>)["PRIVATE-TOKEN"]]), [["https://gitlab.internal/api/v4/projects/old", "manual", "fixture-token"], ["https://gitlab.internal/api/v4/projects/new", "manual", "fixture-token"]]);
  await assert.rejects(send("https://gitlab.internal/api/v4/projects/away", { headers }), /another host \(elsewhere\.example\)/);
  await assert.rejects(send("https://gitlab.internal/api/v4/projects/port", { headers }), /another host \(gitlab\.internal:8443\)/, "a different port is a different origin");
  await assert.rejects(send("https://gitlab.internal/api/v4/projects/loop", { headers }), /Too many provider redirects/);
  assert.deepEqual(await (await send("https://gitlab.internal/api/v4/chain5/0", { headers })).json(), { hops: 5 }, "five redirects are followed");
  await assert.rejects(send("https://gitlab.internal/api/v4/chain6/0", { headers }), /Too many provider redirects/, "a sixth is refused");
  await assert.rejects(send("https://gitlab.internal/api/v4/projects/write", { method: "POST", headers, body: "{}" }), /write request/);
  assert.ok(fake.calls.every((c) => new URL(c.url).host === "gitlab.internal"), "the token never left the original host");
});

test("URL split: GitLab API calls and identity checks use the internal API URL; links keep the external web URL", async (t) => {
  environment(t, { SCM_ALLOWED_HOSTS: "gitlab.example.com,gitlab-api.internal" });
  const fake = fakeFetch((url) => {
    if (url.pathname.endsWith("/repository/commits/main")) return Response.json({ id: "a".repeat(40) });
    if (url.pathname === "/api/v4/user") return Response.json({ id: 7, username: "alice", state: "active" });
    return new Response(null, { status: 404 });
  });
  const network = scmNetwork({ apiUrl: "https://gitlab-api.internal" }, ["gitlab.com"]);
  const client = new Gitlab("https://gitlab.example.com", "fixture-token", "42", network, { fetch: fake.fetch });
  assert.equal(await client.head("group/repo", "main"), "a".repeat(40));
  assert.equal(fake.calls[0].url, "https://gitlab-api.internal/api/v4/projects/42/repository/commits/main");
  assert.match(client.sourceUrl("group/repo", "a".repeat(40), "src/app.ts"), /^https:\/\/gitlab\.example\.com\/group\/repo\/-\/blob\//);
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => fake.fetch(String(input), init));
  assert.deepEqual(await authenticatedProviderIdentity("gitlab", "https://gitlab.example.com", "personal-token", network), { externalId: "7", username: "alice" });
  assert.equal(fake.calls.at(-1)!.url, "https://gitlab-api.internal/api/v4/user");
  const plain = new Gitlab("https://gitlab.example.com", "fixture-token", "42", {}, { fetch: fake.fetch });
  await plain.head("group/repo", "main").catch(() => undefined);
  assert.equal(new URL(fake.calls.at(-1)!.url).host, "gitlab.example.com", "without an API URL, calls go to the instance URL");
});

test("proxy plumbing (local): requests travel through the configured proxy", async (t) => {
  const target = createHttpServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ path: req.url, token: req.headers["private-token"] })); });
  const seen: string[] = [];
  const proxy = createHttpServer((req, res) => {
    // Plain forward proxying (absolute-form request line).
    seen.push(`forward ${req.url}`);
    const url = new URL(req.url!);
    const upstream = connect(Number(url.port), url.hostname, () => {
      upstream.write(`${req.method} ${url.pathname}${url.search} HTTP/1.1\r\nhost: ${url.host}\r\nprivate-token: ${req.headers["private-token"] ?? ""}\r\nconnection: close\r\n\r\n`);
      upstream.pipe(res.socket!);
    });
  });
  proxy.on("connect", (req, socket, head) => {
    seen.push(`connect ${req.url}`);
    const [host, port] = req.url!.split(":");
    const upstream = connect(Number(port), host, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
  });
  const [targetPort, proxyPort] = [await listen(target), await listen(proxy)];
  t.after(() => { target.closeAllConnections(); proxy.closeAllConnections(); target.close(); proxy.close(); });
  environment(t, { SCM_ALLOWED_PROXIES: `127.0.0.1:${proxyPort}` });
  const send = scmFetch({ proxyUrl: proxyOrigin(`http://127.0.0.1:${proxyPort}`) });
  const body = await (await send(`http://127.0.0.1:${targetPort}/api/v4/user`, { headers: { "PRIVATE-TOKEN": "fixture-token" } })).json();
  assert.deepEqual(body, { path: "/api/v4/user", token: "fixture-token" });
  assert.equal(seen.length, 1);
  assert.match(seen[0], new RegExp(`127\\.0\\.0\\.1:${targetPort}`), "the proxy carried the request to the target");
});

test("custom CA (local TLS): a privately signed GitLab is trusted only with its CA bundle, directly and through a proxy", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "openreview-ca-"));
  try {
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
  } catch { t.skip("openssl is not available to create a throwaway certificate"); return; }
  const [key, cert] = await Promise.all([readFile(path.join(dir, "key.pem"), "utf8"), readFile(path.join(dir, "cert.pem"), "utf8")]);
  const server = createHttpsServer({ key, cert }, (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: 9, username: "bot", state: "active" })); });
  const proxy = createHttpServer();
  let tunnels = 0;
  proxy.on("connect", (req, socket, head) => {
    tunnels++;
    const [host, port] = req.url!.split(":");
    const upstream = connect(Number(port), host, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
  });
  const [port, proxyPort] = [await listen(server as unknown as Server), await listen(proxy)];
  t.after(() => { server.closeAllConnections(); proxy.closeAllConnections(); server.close(); proxy.close(); });
  environment(t, { SCM_ALLOWED_PROXIES: `127.0.0.1:${proxyPort}` });
  const url = `https://127.0.0.1:${port}/api/v4/user`;
  await assert.rejects(scmFetch({})(url, {}), "without the CA bundle the certificate is not trusted");
  assert.equal((await scmFetch({ caBundle: cert })(url, {})).status, 200);
  assert.deepEqual(await (await scmFetch({ caBundle: cert, proxyUrl: `http://127.0.0.1:${proxyPort}` })(url, {})).json(), { id: 9, username: "bot", state: "active" });
  assert.equal(tunnels, 1, "the TLS connection to GitLab went through the proxy tunnel");
});
