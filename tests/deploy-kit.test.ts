import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Structure checks for the Helm chart and the AWS Terraform module. They do not replace `helm lint`,
// `helm template` or `terraform validate` (see docs/self-hosting-kit.md); they catch broken references.
const root = path.join(import.meta.dirname, "..");
const chart = path.join(root, "deploy/helm/openreview"), terraform = path.join(root, "deploy/terraform/aws");
const read = (file: string) => readFile(file, "utf8");
const strip = (s: string) => s.replace(/\s+#.*$/gm, "");

// Key paths declared in values.yaml (block mappings and inline `{ a: b }` maps), e.g. "web.image.tag".
function valuePaths(yaml: string) {
  const paths = new Set<string>(), stack: { indent: number; key: string }[] = [];
  for (const line of strip(yaml).split("\n")) {
    const m = /^( *)([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const full = [...stack.map((s) => s.key), m[2]].join(".");
    paths.add(full);
    const inline = /^\s*\{(.*)\}\s*$/.exec(m[3]);
    if (inline) for (const pair of inline[1].split(",")) { const k = pair.split(":")[0].trim(); if (k) paths.add(`${full}.${k}`); }
    stack.push({ indent, key: m[2] });
  }
  return paths;
}

test("Helm chart: every .Values reference exists, includes are defined, and template actions balance", async () => {
  const values = await read(path.join(chart, "values.yaml")), paths = valuePaths(values);
  const templates = (await readdir(path.join(chart, "templates"))).filter((f) => /\.(ya?ml|tpl|txt)$/.test(f));
  assert.deepEqual(templates.sort(), ["NOTES.txt", "_helpers.tpl", "backend.yaml", "configmap.yaml", "ingress.yaml", "secret.yaml", "web.yaml"]);
  const helpers = await read(path.join(chart, "templates/_helpers.tpl"));
  const defined = new Set([...helpers.matchAll(/define "([^"]+)"/g)].map((m) => m[1]));
  for (const file of templates) {
    const text = await read(path.join(chart, "templates", file));
    assert.equal(text.split("{{").length, text.split("}}").length, `${file}: unbalanced template actions`);
    for (const [, ref] of text.matchAll(/\.Values\.([\w.]+)/g)) assert.ok(paths.has(ref), `${file}: .Values.${ref} is not in values.yaml`);
    for (const [, name] of text.matchAll(/include "([^"]+)"/g)) assert.ok(defined.has(name), `${file}: include "${name}" is not defined`);
    const blocks = [...text.matchAll(/\{\{-?\s*(if|with|range|define|end)\b/g)].map((m) => m[1]);
    assert.equal(blocks.filter((b) => b === "end").length, blocks.filter((b) => b !== "end").length, `${file}: unbalanced if/with/range/define`);
  }
  const chartYaml = await read(path.join(chart, "Chart.yaml"));
  assert.match(chartYaml, /^apiVersion: v2$/m);
  assert.match(chartYaml, /^name: openreview$/m);
  assert.match(chartYaml, /^version: \d+\.\d+\.\d+$/m);
});

test("Helm chart: pinned backend, single writer, offline switch, and the instance secret stays with the backend", async () => {
  const values = await read(path.join(chart, "values.yaml"));
  const backend = await read(path.join(chart, "templates/backend.yaml")), web = await read(path.join(chart, "templates/web.yaml"));
  const configmap = await read(path.join(chart, "templates/configmap.yaml"));
  const compose = await read(path.join(root, "docker-compose.yml"));
  const digest = /digest: (sha256:[0-9a-f]{64})/.exec(values)?.[1];
  assert.ok(digest && compose.includes(digest), "the chart pins the same backend image digest as docker-compose.yml");
  assert.match(backend, /@\{\{ \.Values\.backend\.image\.digest \}\}/);
  assert.match(backend, /replicas: 1\n/, "Convex's local data directory has a single writer");
  assert.match(backend, /key: CONVEX_INSTANCE_SECRET/);
  assert.match(configmap, /OPENREVIEW_OFFLINE: \{\{ ternary "true" "false" \.Values\.config\.offline \| quote \}\}/);
  assert.match(values, /^ {2}offline: false/m, "offline mode is opt-in");
  const webKeys = /webKeys: \[([^\]]+)\]/.exec(values)![1].split(",").map((k) => k.trim());
  assert.ok(!webKeys.some((k) => /INSTANCE_SECRET|ADMIN_KEY/.test(k)), "web pods never get the Convex instance secret or admin key");
  for (const key of webKeys) assert.match(key, /^[A-Z][A-Z0-9_]+$/);
  assert.match(values, /^ {2}values: \{\}/m, "no secret values ship in the chart");
  assert.match(web, /runAsNonRoot: true, runAsUser: 1001/);
  assert.match(await read(path.join(root, "Dockerfile")), /--uid 1001/, "the pod user matches the image user");
});

test("Terraform (AWS): references resolve, secrets come from Secrets Manager, and the backend has one writer", async () => {
  const files = (await readdir(terraform)).filter((f) => f.endsWith(".tf")).sort();
  assert.deepEqual(files, ["alb.tf", "ecs.tf", "efs.tf", "network.tf", "outputs.tf", "variables.tf", "versions.tf"]);
  const sources = Object.fromEntries(await Promise.all(files.map(async (f) => [f, strip(await read(path.join(terraform, f)))] as const)));
  const all = Object.values(sources).join("\n");
  const variables = new Set([...sources["variables.tf"].matchAll(/^variable "(\w+)"/gm)].map((m) => m[1]));
  const resources = new Set([...all.matchAll(/^resource "(\w+)" "(\w+)"/gm)].map((m) => `${m[1]}.${m[2]}`));
  const data = new Set([...all.matchAll(/^data "(\w+)" "(\w+)"/gm)].map((m) => `data.${m[1]}.${m[2]}`));
  const locals = new Set([...all.matchAll(/^locals \{([\s\S]*?)^\}/gm)].flatMap((m) => [...m[1].matchAll(/^ {2}(\w+)\s*=/gm)].map((l) => l[1])));
  for (const [file, text] of Object.entries(sources)) {
    assert.equal(text.split("{").length, text.split("}").length, `${file}: unbalanced braces`);
    for (const [, name] of text.matchAll(/\bvar\.(\w+)/g)) assert.ok(variables.has(name), `${file}: var.${name} is not declared`);
    for (const [, name] of text.matchAll(/\blocal\.(\w+)/g)) assert.ok(locals.has(name), `${file}: local.${name} is not defined`);
    for (const [ref] of text.matchAll(/\bdata\.aws_\w+\.\w+/g)) assert.ok(data.has(ref), `${file}: ${ref} is not declared`);
    for (const [, type, name] of text.matchAll(/(?<![".\w])(aws_\w+)\.(\w+)(?=[.[\s,)\]])/g)) assert.ok(resources.has(`${type}.${name}`), `${file}: ${type}.${name} is not declared`);
  }
  assert.match(sources["versions.tf"], /source\s+= "hashicorp\/aws"\s+version\s+= "~> \d+\.\d+"/, "the provider version is pinned");
  const ecs = sources["ecs.tf"];
  assert.match(ecs, /resource "aws_ecs_service" "backend" \{[\s\S]*?desired_count\s+= 1\n[\s\S]*?deployment_maximum_percent\s+= 100/, "never two backend tasks on the same data");
  assert.match(ecs, /k != "CONVEX_INSTANCE_SECRET"/, "the web task does not receive the instance secret");
  assert.match(ecs, /secrets\s+= \[for k, v in local\.web_secrets : \{ name = k, valueFrom = v \}\]/, "web secrets are Secrets Manager references");
  assert.match(ecs, /OPENREVIEW_OFFLINE\s+= tostring\(var\.offline\)/);
  assert.match(sources["network.tf"], /cidr_blocks = var\.egress_cidrs/, "task egress is narrowable for offline installs");
  assert.match(sources["efs.tf"], /encrypted\s+= true/);
  assert.match(sources["alb.tf"], /ssl_policy\s+= "ELBSecurityPolicy-TLS13/);
  assert.doesNotMatch(all, /(sk_live|xox[bp]-|ghp_|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)/, "no credentials in the module");
});
