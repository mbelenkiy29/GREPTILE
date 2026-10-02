import { describe, expect, test } from "vitest";
import { analyzeFile } from "@/lib/indexer/analyze";
import { chunkCode, chunkDoc, MAX_CHUNK_BYTES, MAX_CHUNK_LINES, splitLines } from "@/lib/indexer/chunks";
import { classifyPath, detectFileType, skipReasonForPath } from "@/lib/indexer/filetypes";
import { parseManifest } from "@/lib/indexer/manifests";
import { normalizeRoutePath } from "@/lib/indexer/routes";
import { REDACTED_SECRET, isSecretFilePath, redactSecrets, scanForSecrets } from "@/lib/security/secret-scan";

/** Fake credentials are assembled at runtime so no secret-shaped literal sits in the repository. */
const fake = {
  aws: ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
  github: ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0".repeat(2)].join(""),
  gitlab: ["glpat", "-", "x1Y2z3A4b5C6d7E8f9G0"].join(""),
  slack: ["xoxb", "-", "1234567890-abcdefghij"].join(""),
  stripe: ["sk", "_live_", "4eC39HqLyjWDarjtT1zdp7dc"].join(""),
  openai: ["sk", "-proj-", "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56"].join(""),
  anthropic: ["sk", "-ant-", "api03-", "Zy98Xw76Vu54Ts32Rq10Po98Nm76Lk54"].join(""),
  pemBegin: ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
  pemEnd: ["-----END", "RSA PRIVATE KEY-----"].join(" "),
};

async function analyze(path: string, text: string) {
  return analyzeFile(path, text, detectFileType(path)!, { repoName: "shop" });
}

describe("secret scanning", () => {
  test("R6.3 detects provider tokens, private keys, and high-entropy assigned secrets", () => {
    const text = [
      `const region = "us-east-1";`,
      `AWS_ACCESS_KEY_ID=${fake.aws}`,
      `token: ${fake.github}`,
      `const gl = "${fake.gitlab}";`,
      `SLACK=${fake.slack}`,
      `stripe.key = "${fake.stripe}"`,
      `OPENAI_API_KEY=${fake.openai}`,
      `const anthropic = "${fake.anthropic}";`,
      fake.pemBegin,
      "MIIEowIBAAKCAQEAx1y2z3",
      fake.pemEnd,
      `const apiKey = "Q7f9Lm2Xr8Tz4Wb6Nc1V";`,
      `db_password: "s3cR3t-Pa55-w0rd-xY9z"`,
      `const tokenCount = computeTokens(text);`,
      `const password = process.env.DB_PASSWORD;`,
      `API_KEY=your-api-key-here`,
      `const secretName = "payments-signing-key";`,
    ].join("\n");
    const findings = scanForSecrets(text);
    expect(findings.map((f) => [f.line, f.rule])).toEqual([
      [2, "aws_access_key_id"],
      [3, "github_token"],
      [4, "gitlab_token"],
      [5, "slack_token"],
      [6, "stripe_key"],
      [7, "openai_key"],
      [8, "anthropic_key"],
      [9, "private_key"],
      [10, "private_key"],
      [11, "private_key"],
      [12, "assigned_secret"],
      [13, "assigned_secret"],
    ]);
    // Previews never carry the secret itself.
    for (const f of findings) expect(text.includes(f.preview) && f.preview.length > 12).toBe(false);
  });

  test("R6.3 redacts whole secret lines, keeping indentation and line numbers", () => {
    const text = `def connect():\n    token = "${fake.github}"\n    return client(token)\n`;
    const redacted = redactSecrets(text);
    expect(redacted).toBe(`def connect():\n    ${REDACTED_SECRET}\n    return client(token)\n`);
    expect(redacted.split("\n")).toHaveLength(text.split("\n").length);
    expect(redactSecrets("nothing to see here\n")).toBe("nothing to see here\n");
  });

  test("R6.3 recognizes secret files by name", () => {
    for (const p of [".env", "config/.env.production", "certs/server.pem", "keys/api.key", "store.p12", "cert.pfx", "home/.ssh/id_rsa", "id_ed25519.pub", "app.keystore", "credentials-prod.json", "secrets.yaml", "deploy/secrets.json"]) {
      expect(isSecretFilePath(p), p).toBe(true);
    }
    for (const p of [".env.example", ".env.sample", ".env.template", "src/env.ts", "docs/secrets-guide.md", "keyboard.ts"]) {
      expect(isSecretFilePath(p), p).toBe(false);
    }
  });
});

describe("skip rules and classification", () => {
  test("R6.3 skips vendored, generated, binary, oversized, secret, and unsupported files by path", () => {
    const cases: [string, number, string | null][] = [
      ["node_modules/left-pad/index.js", 10, "vendored"],
      ["vendor/github.com/x/y.go", 10, "vendored"],
      ["web/dist/app.js", 10, "vendored"],
      ["services/api/.venv/lib/site.py", 10, "vendored"],
      ["ios/Pods/Foo/Foo.m", 10, "vendored"],
      ["src/__generated__/types.ts", 10, "vendored"],
      ["public/app.min.js", 10, "generated"],
      ["src/schema.generated.ts", 10, "generated"],
      ["api/user.pb.go", 10, "generated"],
      ["proto/user_pb2.py", 10, "generated"],
      ["pnpm-lock.yaml", 10, "generated"],
      ["Cargo.lock", 10, "generated"],
      ["go.sum", 10, "generated"],
      ["assets/logo.png", 10, "binary"],
      ["fonts/inter.woff2", 10, "binary"],
      ["data/big.json", 600_000, "too_large"],
      [".env.local", 10, "secret_file"],
      ["certs/tls.pem", 10, "secret_file"],
      ["LICENSE", 10, "unsupported"],
      ["src/index.ts", 600, null],
      ["docs/guide.md", 600, null],
      [".env.example", 60, null],
      ["Dockerfile", 60, null],
    ];
    for (const [p, size, reason] of cases) expect(skipReasonForPath(p, size), p).toBe(reason);
    expect(skipReasonForPath("src/big.ts", 2_000, 1_000)).toBe("too_large");
  });

  test("R6.3 classifies files with tags", () => {
    const tags = (p: string) => classifyPath(p, detectFileType(p)!).sort();
    expect(tags("src/cart.ts")).toEqual(["source"]);
    expect(tags("src/cart.test.ts")).toEqual(["test"]);
    expect(tags("tests/test_cart.py")).toEqual(["test"]);
    expect(tags("store/store_test.go")).toEqual(["test"]);
    expect(tags("src/test/java/app/CartTest.java")).toEqual(["test"]);
    expect(tags("Billing.Tests/InvoiceTests.cs")).toEqual(["test"]);
    expect(tags("next.config.ts")).toEqual(["config"]);
    expect(tags("docker-compose.yml")).toEqual(["config"]);
    expect(tags("package.json")).toEqual(["manifest"]);
    expect(tags("requirements-dev.txt")).toEqual(["manifest"]);
    expect(tags("db/migrations/001_init.sql")).toEqual(["migration", "source"]);
    expect(tags("prisma/schema.prisma")).toEqual(["schema", "source"]);
    expect(tags("src/app/api/users/route.ts")).toEqual(["route", "source"]);
    expect(tags("README.md")).toEqual(["doc"]);
    expect(tags("docs/adr/0001-postgres.md")).toEqual(["doc"]);
    expect(tags("CLAUDE.md")).toEqual(["doc", "instructions"]);
    expect(tags("AGENTS.md")).toEqual(["doc", "instructions"]);
    expect(tags("CONTRIBUTING.md")).toEqual(["doc", "instructions"]);
    expect(tags(".cursorrules")).toEqual(["doc", "instructions"]);
    expect(tags(".github/copilot-instructions.md")).toEqual(["doc", "instructions"]);
    expect(tags("openreview.json")).toEqual(["config", "instructions"]);
    expect(tags(".github/workflows/ci.yml")).toEqual(["ci", "config"]);
    expect(tags("Jenkinsfile")).toEqual(["ci", "config"]);
  });

  test("R6.3 adds content-derived tags: route, schema, generated", async () => {
    expect((await analyze("src/routes.ts", `import express from "express";\nconst router = express.Router();\nrouter.get("/a", h);\n`)).tags).toEqual(["route", "source"]);
    expect((await analyze("db/schema.ts", `export const users = pgTable("users", {});\n`)).tags).toEqual(["schema", "source"]);
    expect((await analyze("gen/client.go", `// Code generated by protoc-gen-go. DO NOT EDIT.\npackage gen\n`)).tags).toEqual(["generated"]);
  });
});

describe("manifests", () => {
  test("R6.3 parses package manifests into modules and dependencies", () => {
    const deps = (type: Parameters<typeof parseManifest>[0], path: string, text: string) => {
      const m = parseManifest(type, path, text, "shop")!;
      return { name: m.name, deps: m.dependencies.map((d) => `${d.ecosystem}:${d.name}@${d.versionSpec ?? "*"}:${d.kind}`), local: m.localModules, workspaces: m.workspaces };
    };
    expect(
      deps(
        "package.json",
        "package.json",
        JSON.stringify({
          name: "@acme/web",
          workspaces: ["packages/*"],
          dependencies: { express: "^4.18.2", "@acme/core": "workspace:*" },
          devDependencies: { vitest: "^1.0.0" },
          peerDependencies: { react: ">=18" },
          optionalDependencies: { fsevents: "^2" },
        }),
      ),
    ).toEqual({
      name: "@acme/web",
      deps: ["npm:express@^4.18.2:prod", "npm:@acme/core@workspace:*:prod", "npm:vitest@^1.0.0:dev", "npm:react@>=18:peer", "npm:fsevents@^2:optional"],
      local: [],
      workspaces: ["packages/*"],
    });
    expect(deps("requirements.txt", "requirements-dev.txt", "# tools\npytest>=7\n-r requirements.txt\nblack==23.1 ; python_version > '3.8'\n").deps).toEqual([
      "pypi:pytest@>=7:dev",
      "pypi:black@==23.1:dev",
    ]);
    expect(deps("requirements.txt", "api/requirements.txt", "Django>=4.2,<5\nrequests[security]==2.31.0\n")).toMatchObject({
      name: "api",
      deps: ["pypi:django@>=4.2,<5:prod", "pypi:requests@==2.31.0:prod"],
    });
    expect(
      deps(
        "pyproject.toml",
        "pyproject.toml",
        `[project]\nname = "shop-py"\ndependencies = ["fastapi>=0.100", "pydantic"]\n[project.optional-dependencies]\ndev = ["mypy"]\nredis = ["redis>=5"]\n[build-system]\nrequires = ["setuptools>=61"]\n[tool.poetry.group.test.dependencies]\npytest = "^7"\n`,
      ),
    ).toMatchObject({
      name: "shop-py",
      deps: ["pypi:fastapi@>=0.100:prod", "pypi:pydantic@*:prod", "pypi:mypy@*:dev", "pypi:redis@>=5:optional", "pypi:setuptools@>=61:build", "pypi:pytest@^7:dev"],
    });
    expect(deps("Pipfile", "Pipfile", `[packages]\nflask = "*"\n[dev-packages]\npytest = {version = ">=7"}\n`).deps).toEqual(["pypi:flask@*:prod", "pypi:pytest@>=7:dev"]);
    expect(
      deps("go.mod", "go.mod", `module example.com/shop\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/text v0.14.0 // indirect\n)\nrequire github.com/google/uuid v1.6.0\n`),
    ).toMatchObject({
      name: "example.com/shop",
      deps: ["go:github.com/gin-gonic/gin@v1.9.1:prod", "go:golang.org/x/text@v0.14.0:optional", "go:github.com/google/uuid@v1.6.0:prod"],
    });
    expect(
      deps(
        "Cargo.toml",
        "meter/Cargo.toml",
        `[package]\nname = "meter"\n[dependencies]\nserde = "1.0"\nlocal = { path = "../local" }\n[dev-dependencies]\ntokio = { version = "1", features = ["full"] }\n[build-dependencies]\ncc = "1"\n`,
      ),
    ).toMatchObject({ name: "meter", deps: ["cargo:serde@1.0:prod", "cargo:local@path:../local:prod", "cargo:tokio@1:dev", "cargo:cc@1:build"] });
    expect(
      deps(
        "pom.xml",
        "billing/pom.xml",
        `<project><parent><groupId>com.acme</groupId><artifactId>parent</artifactId></parent><artifactId>billing</artifactId>
         <dependencies>
           <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
           <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
         </dependencies></project>`,
      ),
    ).toMatchObject({ name: "com.acme:billing", deps: ["maven:org.springframework.boot:spring-boot-starter-web@*:prod", "maven:junit:junit@4.13.2:dev"] });
    expect(
      deps(
        "build.gradle",
        "core/build.gradle.kts",
        `dependencies {\n  implementation("com.google.guava:guava:32.1.0-jre")\n  testImplementation 'junit:junit:4.13.2'\n  implementation(project(":common"))\n}\n`,
      ),
    ).toEqual({ name: ":core", deps: ["maven:com.google.guava:guava@32.1.0-jre:prod", "maven:junit:junit@4.13.2:dev"], local: [":common"], workspaces: [] });
    expect(
      deps(
        "csproj",
        "src/Billing/Billing.csproj",
        `<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /><PackageReference Include="StyleCop.Analyzers" Version="1.1" PrivateAssets="all" /><ProjectReference Include="..\\Core\\Core.csproj" /></ItemGroup></Project>`,
      ),
    ).toEqual({ name: "Billing", deps: ["nuget:Newtonsoft.Json@13.0.3:prod", "nuget:StyleCop.Analyzers@1.1:dev"], local: ["Core"], workspaces: [] });
    expect(deps("Gemfile", "Gemfile", `source "https://rubygems.org"\ngem "rails", "~> 7.0"\ngroup :development, :test do\n  gem "rspec-rails"\nend\ngem "pg"\n`)).toMatchObject({
      name: "shop",
      deps: ["rubygems:rails@~> 7.0:prod", "rubygems:rspec-rails@*:dev", "rubygems:pg@*:prod"],
    });
    expect(parseManifest("package.json", "package.json", "{ not json", "shop")).toBeNull();
  });

  test("R6.3 turns a manifest into a module symbol with depends_on edges", async () => {
    const a = await analyze("packages/web/package.json", JSON.stringify({ name: "@acme/web", dependencies: { "@acme/core": "workspace:*", express: "^4" } }));
    expect(a.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(["module:@acme/web"]);
    expect(a.symbols[0]!.signature).toBe("npm module @acme/web");
    const root = await analyze("package.json", JSON.stringify({ name: "@acme/shop", workspaces: { packages: ["packages/*", "apps/*"] } }));
    expect(root.symbols[0]!.signature).toBe("npm module @acme/shop (workspaces: packages/*, apps/*)");
    expect(a.edges.map((e) => `${e.kind}:${e.target}`)).toEqual(["depends_on:@acme/core", "depends_on:express"]);
    expect(a.dependencies).toHaveLength(2);
  });
});

describe("routes", () => {
  const routes = async (path: string, text: string) => {
    const a = await analyze(path, text);
    const handlerOf = (i: number) => a.edges.find((e) => e.kind === "route_handler" && e.from === i)?.target ?? null;
    return a.symbols.flatMap((s, i) => (s.kind === "route" ? [`${s.name} -> ${handlerOf(i)}`] : []));
  };

  test("R6.3 normalizes route paths across framework syntaxes", () => {
    expect(normalizeRoutePath("users/{id:int}/")).toBe("/users/:id");
    expect(normalizeRoutePath("/files/<path:name>")).toBe("/files/:name");
    expect(normalizeRoutePath("/blog/[slug]/[...rest]")).toBe("/blog/:slug/:rest*");
    expect(normalizeRoutePath("")).toBe("/");
  });

  test("R6.3 extracts routes from Next.js, Express, FastAPI, Flask, Django, Go, Spring, and ASP.NET", async () => {
    expect(await routes("src/app/api/users/[id]/route.ts", `export async function GET() { return list(); }\nexport const DELETE = remove;\nexport function helper() {}\n`)).toEqual([
      "GET /api/users/:id -> GET",
      "DELETE /api/users/:id -> DELETE",
    ]);
    expect(await routes("app/(shop)/orders/route.js", `export function POST(req) {}\n`)).toEqual(["POST /orders -> POST"]);
    expect(await routes("pages/api/health/index.ts", `export default function handler(req, res) { res.end(); }\n`)).toEqual(["ANY /api/health -> handler"]);
    expect(
      await routes(
        "src/server.ts",
        `import express from "express";\nimport { listOrders } from "./orders";\nconst router = express.Router();\nrouter.get("/orders", listOrders);\nrouter.post("/orders/:id/pay", auth, orders.pay);\napp.delete("/x", async (req, res) => {});\naxios.get("/not-a-route", cfg);\n`,
      ),
    ).toEqual(["GET /orders -> listOrders", "POST /orders/:id/pay -> pay", "DELETE /x -> null"]);
    expect(await routes("src/client.ts", `const api = axios.create();\napi.get("/users", { params });\n`)).toEqual([]);
    expect(
      await routes(
        "api/main.py",
        `from fastapi import FastAPI, APIRouter\napp = FastAPI()\nrouter = APIRouter(prefix="/users")\n\n@app.get("/items/{item_id}")\nasync def read_item(item_id: int):\n    return item_id\n\n@router.post("/")\ndef create_user():\n    pass\n`,
      ),
    ).toEqual(["GET /items/:item_id -> read_item", "POST /users -> create_user"]);
    expect(await routes("web/views.py", `@bp.route("/login", methods=["GET", "POST"])\ndef login():\n    pass\n`)).toEqual(["GET /login -> login", "POST /login -> login"]);
    expect(await routes("shop/urls.py", `urlpatterns = [\n    path("orders/<int:pk>/", views.order_detail),\n    path("cart/", CartView.as_view()),\n]\n`)).toEqual([
      "ANY /orders/:pk -> order_detail",
      "ANY /cart -> CartView",
    ]);
    expect(
      await routes(
        "cmd/server/routes.go",
        `package main\n\nfunc routes(mux *http.ServeMux, r *gin.Engine) {\n\tmux.HandleFunc("GET /items/{id}", getItem)\n\thttp.HandleFunc("/health", health)\n\tr.POST("/users", h.CreateUser)\n\thttp.Get("https://example.com")\n}\n`,
      ),
    ).toEqual(["GET /items/:id -> getItem", "ANY /health -> health", "POST /users -> CreateUser"]);
    expect(
      await routes(
        "src/main/java/com/acme/BillController.java",
        `@RestController\n@RequestMapping("/api")\npublic class BillController {\n  @GetMapping("/bills/{id}")\n  public Bill get(@PathVariable long id) { return null; }\n  @RequestMapping(value = "/bills", method = RequestMethod.POST)\n  public Bill create() { return null; }\n}\n`,
      ),
    ).toEqual(["GET /api/bills/:id -> get", "POST /api/bills -> create"]);
    expect(
      await routes(
        "Controllers/InvoicesController.cs",
        `[ApiController]\n[Route("api/[controller]")]\npublic class InvoicesController : ControllerBase {\n  [HttpGet("{id}")]\n  public IActionResult Get(int id) => Ok();\n  [HttpPost]\n  public IActionResult Create() => Ok();\n}\napp.MapGet("/ping", Ping);\n`,
      ),
    ).toEqual(["GET /api/Invoices/:id -> Get", "POST /api/Invoices -> Create", "GET /ping -> Ping"]);
  });
});

describe("schemas", () => {
  const entities = async (path: string, text: string) => (await analyze(path, text)).symbols.filter((s) => ["table", "model"].includes(s.kind)).map((s) => `${s.kind}:${s.name}`);

  test("R6.3 extracts database schemas from SQL, Prisma, Drizzle, Django, TypeORM, and SQLAlchemy", async () => {
    expect(
      await entities(
        "db/migrations/001_init.sql",
        `-- CREATE TABLE commented_out (id int);\nCREATE TABLE orders (\n  id serial primary key,\n  note text default 'CREATE TABLE nope'\n);\ncreate table if not exists "public"."users" (id int);\nCREATE UNLOGGED TABLE [dbo].[audit_log] (id int);\n`,
      ),
    ).toEqual(["table:orders", "table:users", "table:audit_log"]);
    const sql = await analyze("db/schema.sql", `CREATE TABLE orders (\n  id int,\n  total int\n);\n`);
    expect(sql.symbols[0]).toMatchObject({ name: "orders", startLine: 1, endLine: 4 });
    expect(await entities("prisma/schema.prisma", `model User {\n  id    Int    @id\n  posts Post[]\n}\n\nmodel Post {\n  id Int @id\n  author User @relation(fields: [authorId], references: [id])\n  @@map("blog_posts")\n}\n`)).toEqual([
      "model:User",
      "table:User",
      "model:Post",
      "table:blog_posts",
    ]);
    expect(await entities("src/db/schema.ts", `import { pgTable, serial } from "drizzle-orm/pg-core";\nexport const invoices = pgTable("invoices", { id: serial("id") });\nexport const audit = sqliteTable("audit_log", {});\n`)).toEqual([
      "table:invoices",
      "table:audit_log",
    ]);
    expect(await entities("shop/models.py", `from django.db import models\n\nclass Order(models.Model):\n    total = models.IntegerField()\n\nclass Helper:\n    pass\n`)).toEqual(["model:Order"]);
    expect(await entities("src/entities/customer.ts", `@Entity("customers")\nexport class Customer {\n  @PrimaryGeneratedColumn() id: number;\n}\n`)).toEqual(["table:customers", "model:Customer"]);
    expect(await entities("app/models.py", `class Account(Base):\n    __tablename__ = "accounts"\n    id = Column(Integer)\n\nusers = Table("users", metadata)\n`)).toEqual([
      "model:Account",
      "table:accounts",
      "table:users",
    ]);
    expect(await entities("src/main/java/com/acme/Bill.java", `@Entity\n@Table(name = "bills")\npublic class Bill {}\n`)).toEqual(["model:Bill", "table:bills"]);
  });
});

describe("CI workflows", () => {
  const jobs = async (path: string, text: string) =>
    (await analyze(path, text)).symbols.filter((s) => s.kind === "ci_job").map((s) => ({ name: s.name, q: s.qualifiedName, lines: [s.startLine, s.endLine], run: s.content }));

  test("R6.3 extracts CI jobs from GitHub Actions, GitLab, CircleCI, Jenkins, and Azure Pipelines", async () => {
    const gh = await jobs(
      ".github/workflows/ci.yml",
      `name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pnpm test\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm lint\n`,
    );
    expect(gh.map((j) => [j.name, j.q, j.lines])).toEqual([
      ["test", "CI/test", [4, 8]],
      ["lint", "CI/lint", [9, 12]],
    ]);
    expect(gh[0]!.run).toContain("pnpm test");
    expect((await jobs(".gitlab-ci.yml", `stages: [build, test]\nvariables:\n  A: b\n.template:\n  script: echo hidden\nbuild:\n  stage: build\n  script:\n    - make build\nunit:\n  extends: .template\n`)).map((j) => j.name)).toEqual([
      "build",
      "unit",
    ]);
    expect((await jobs(".circleci/config.yml", `version: 2.1\njobs:\n  build:\n    docker:\n      - image: cimg/node:20.0\n    steps:\n      - run: npm test\n`)).map((j) => j.name)).toEqual(["build"]);
    const jenkins = await jobs("Jenkinsfile", `pipeline {\n  stages {\n    stage('Build') {\n      steps { sh 'make' }\n    }\n    stage("Test") {\n      steps { sh 'make test' }\n    }\n  }\n}\n`);
    expect(jenkins.map((j) => [j.name, j.lines])).toEqual([
      ["Build", [3, 5]],
      ["Test", [6, 10]],
    ]);
    expect(jenkins[1]!.run).toContain("make test");
    expect(
      (await jobs("azure-pipelines.yml", `stages:\n  - stage: CI\n    jobs:\n      - job: Build\n        steps:\n          - script: dotnet build\n      - job: Test\n        steps:\n          - script: dotnet test\n`)).map((j) => j.name),
    ).toEqual(["Build", "Test"]);
    expect((await jobs("azure-pipelines.yml", `trigger: [main]\nsteps:\n  - script: echo hi\n`)).map((j) => j.name)).toEqual(["default"]);
  });
});

describe("chunks", () => {
  test("R6.3 chunks code on symbol boundaries within the size limits", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    const chunks = chunkCode(lines, [
      { startLine: 1, endLine: 90 },
      { startLine: 91, endLine: 200 },
      { startLine: 201, endLine: 300 },
    ]);
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 90],
      [91, 200],
      [201, 300],
    ]);
    const long = chunkCode(Array.from({ length: 400 }, () => "x"), []);
    expect(long.every((c) => c.endLine - c.startLine + 1 <= MAX_CHUNK_LINES)).toBe(true);
    const wide = chunkCode(Array.from({ length: 50 }, () => "y".repeat(1000)), []);
    expect(wide.every((c) => Buffer.byteLength(c.content) <= MAX_CHUNK_BYTES)).toBe(true);
    expect(wide.map((c) => c.endLine).pop()).toBe(50);
  });

  test("R6.3 chunks docs by heading, ignoring headings inside code fences", () => {
    const md = splitLines(`# Title\nintro\n\n## Setup\nrun it\n\`\`\`sh\n# not a heading\n\`\`\`\n## Usage\nuse it\n`);
    expect(chunkDoc(md, "markdown").map((c) => [c.startLine, c.endLine, c.content.split("\n")[0]])).toEqual([
      [1, 3, "# Title"],
      [4, 8, "## Setup"],
      [9, 10, "## Usage"],
    ]);
  });
});
