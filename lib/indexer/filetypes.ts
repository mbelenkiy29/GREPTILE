/**
 * What the indexer does with each path (R6.3): skip rules (vendored, generated, binary, oversized, secret files),
 * file type detection (tree-sitter code, other code, docs, config), and classification tags.
 */
import path from "node:path/posix";
import { isSecretFilePath } from "@/lib/security/secret-scan";
import { languageForPath, type LanguageSpec } from "./languages";

export type SkipReason = "vendored" | "generated" | "binary" | "too_large" | "secret_file" | "unsupported";

export type FileTag =
  | "source"
  | "test"
  | "config"
  | "manifest"
  | "schema"
  | "migration"
  | "route"
  | "doc"
  | "ci"
  | "instructions"
  | "generated";

export type FileCategory = "code" | "doc" | "config";

export type ManifestType =
  | "package.json"
  | "requirements.txt"
  | "pyproject.toml"
  | "Pipfile"
  | "go.mod"
  | "Cargo.toml"
  | "pom.xml"
  | "build.gradle"
  | "csproj"
  | "Gemfile";

export type CiType = "github" | "gitlab" | "circleci" | "jenkins" | "azure";

export interface FileType {
  /** Stored in `files.language`. */
  language: string;
  category: FileCategory;
  /** Present when the file is parsed with tree-sitter. */
  treeSitter?: LanguageSpec;
  manifest?: ManifestType;
  ci?: CiType;
}

export const DEFAULT_MAX_FILE_BYTES = 524_288;

const VENDORED_DIRS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  "coverage",
  "__generated__",
  "generated",
  ".venv",
  "venv",
  "Pods",
  "__pycache__",
  "bower_components",
  ".yarn",
  ".tox",
  ".gradle",
  ".terraform",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "packages.lock.json",
  "podfile.lock",
  "pubspec.lock",
  "mix.lock",
  "flake.lock",
]);

const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp ico icns webp avif tif tiff psd ai sketch fig heic " +
    "pdf doc docx xls xlsx ppt pptx odt ods " +
    "zip gz tgz tar bz2 xz lz4 zst 7z rar jar war ear aar apk ipa dmg iso deb rpm msi " +
    "exe dll so dylib a o obj lib class pyc pyo wasm node bin dat " +
    "woff woff2 ttf otf eot " +
    "mp3 mp4 m4a wav ogg flac mov avi mkv webm " +
    "db sqlite sqlite3 parquet avro orc pkl pt pth onnx h5 npy npz tflite"
  ).split(" "),
);

/** Non-tree-sitter source languages indexed as code chunks (full-text searchable). */
const OTHER_CODE: Record<string, string> = {
  ".d.ts": "typescript",
  ".rb": "ruby",
  ".rake": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".m": "objective-c",
  ".mm": "objective-c",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".lua": "lua",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".clj": "clojure",
  ".r": "r",
  ".pl": "perl",
  ".pm": "perl",
  ".groovy": "groovy",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".sql": "sql",
  ".prisma": "prisma",
  ".tf": "hcl",
  ".hcl": "hcl",
  ".vb": "vb",
  ".fs": "fsharp",
  ".zig": "zig",
  ".jl": "julia",
  ".sol": "solidity",
};

const DOCS: Record<string, string> = {
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".rst": "rst",
  ".adoc": "asciidoc",
  ".txt": "text",
};

const CONFIG: Record<string, string> = {
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".properties": "properties",
  ".xml": "xml",
  ".csproj": "xml",
  ".fsproj": "xml",
  ".vbproj": "xml",
  ".editorconfig": "ini",
};

/** Files recognized by name (lower-cased basename). */
const BY_NAME: Record<string, Omit<FileType, "treeSitter">> = {
  dockerfile: { language: "dockerfile", category: "config" },
  makefile: { language: "make", category: "config" },
  jenkinsfile: { language: "groovy", category: "config", ci: "jenkins" },
  gemfile: { language: "ruby", category: "config", manifest: "Gemfile" },
  rakefile: { language: "ruby", category: "code" },
  pipfile: { language: "toml", category: "config", manifest: "Pipfile" },
  "go.mod": { language: "go-mod", category: "config", manifest: "go.mod" },
  ".cursorrules": { language: "text", category: "doc" },
  ".env.example": { language: "dotenv", category: "config" },
  ".env.sample": { language: "dotenv", category: "config" },
  ".env.template": { language: "dotenv", category: "config" },
  ".gitignore": { language: "ignore", category: "config" },
  readme: { language: "text", category: "doc" },
  contributing: { language: "text", category: "doc" },
  codeowners: { language: "codeowners", category: "config" },
  ".dockerignore": { language: "ignore", category: "config" },
};

function extOf(p: string): string {
  const base = path.basename(p).toLowerCase();
  if (base.endsWith(".d.ts")) return ".d.ts";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? (base.startsWith(".") ? base : "") : base.slice(dot);
}

function manifestFor(lower: string): ManifestType | undefined {
  if (lower === "package.json") return "package.json";
  if (/^requirements(?:[-_.][\w.-]+)?\.txt$/.test(lower) || /^[\w-]*requirements\.txt$/.test(lower)) return "requirements.txt";
  if (lower === "pyproject.toml") return "pyproject.toml";
  if (lower === "cargo.toml") return "Cargo.toml";
  if (lower === "pom.xml") return "pom.xml";
  if (lower === "build.gradle" || lower === "build.gradle.kts") return "build.gradle";
  if (lower.endsWith(".csproj")) return "csproj";
  return undefined;
}

export function ciTypeFor(p: string): CiType | undefined {
  const lower = p.toLowerCase();
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(lower)) return "github";
  if (lower === ".gitlab-ci.yml" || lower === ".gitlab-ci.yaml") return "gitlab";
  if (lower === ".circleci/config.yml" || lower === ".circleci/config.yaml") return "circleci";
  if (path.basename(lower) === "jenkinsfile") return "jenkins";
  if (lower === "azure-pipelines.yml" || lower === "azure-pipelines.yaml") return "azure";
  return undefined;
}

/** How to index `p`, or undefined when it is not a file type the indexer understands. */
export function detectFileType(p: string): FileType | undefined {
  const lower = path.basename(p).toLowerCase();
  const ci = ciTypeFor(p);
  const manifest = manifestFor(lower);
  const named = BY_NAME[lower] ?? (lower.startsWith("dockerfile") ? BY_NAME.dockerfile : undefined);
  if (named) return { ...named, ...(ci ? { ci } : {}) };

  const ext = extOf(p);
  if (manifest) {
    const language = ext === ".kts" ? "kotlin" : ext === ".gradle" ? "groovy" : CONFIG[ext] ?? (ext === ".txt" ? "pip-requirements" : "text");
    return { language, category: "config", manifest };
  }
  const spec = languageForPath(p);
  if (spec) return { language: spec.id, category: "code", treeSitter: spec };
  if (ext === ".gradle") return { language: "groovy", category: "config" };
  const code = OTHER_CODE[ext];
  if (code) return { language: code, category: "code" };
  const doc = DOCS[ext];
  if (doc) return { language: doc, category: "doc" };
  const config = CONFIG[ext];
  if (config) return { language: config, category: "config", ...(ci ? { ci } : {}) };
  return undefined;
}

function segments(p: string): string[] {
  return p.split("/");
}

/** Why a tracked file is not indexed, decided from its path and size alone (no read). */
export function skipReasonForPath(p: string, sizeBytes: number, maxBytes = DEFAULT_MAX_FILE_BYTES): SkipReason | null {
  const segs = segments(p);
  if (segs.slice(0, -1).some((s) => VENDORED_DIRS.has(s))) return "vendored";
  if (isSecretFilePath(p)) return "secret_file";
  const base = segs[segs.length - 1]!.toLowerCase();
  if (
    LOCKFILES.has(base) ||
    /\.min\.[a-z0-9]+$/.test(base) ||
    /\.generated\.[a-z0-9]+$/.test(base) ||
    base.endsWith(".pb.go") ||
    /_pb2(?:_grpc)?\.pyi?$/.test(base) ||
    base.endsWith(".map")
  ) {
    return "generated";
  }
  const ext = extOf(p).slice(1);
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  if (sizeBytes > maxBytes) return "too_large";
  if (!detectFileType(p)) return "unsupported";
  return null;
}

/** True when the first 8 KB contain a NUL byte (the same heuristic git uses). */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) if (head[i] === 0) return true;
  return false;
}

const TEST_DIRS = new Set(["test", "tests", "__tests__", "__test__", "spec", "specs"]);

/** Test files by convention: `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*_test.py`, `*Test.java`, `*Tests.cs`, tests/ dirs. */
export function isTestPath(p: string): boolean {
  const segs = segments(p);
  const base = segs[segs.length - 1]!;
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(base)) return true;
  if (/_test\.(?:go|py|rb|exs?)$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base)) return true;
  if (/(?:Test|Tests|IT)\.(?:java|kt)$/.test(base)) return true;
  if (/Tests?\.cs$/.test(base)) return true;
  if (/_spec\.rb$/.test(base)) return true;
  const type = detectFileType(p);
  if (type?.category !== "code") return false;
  return segs.slice(0, -1).some((s) => TEST_DIRS.has(s));
}

const INSTRUCTION_FILES = new Set([
  "claude.md",
  "agents.md",
  ".cursorrules",
  "openreview.json",
  "contributing.md",
  "contributing",
  "contributing.rst",
  "contributing.txt",
]);

export function isInstructionsPath(p: string): boolean {
  const lower = p.toLowerCase();
  const base = path.basename(lower);
  if (INSTRUCTION_FILES.has(base) || /^contributing\./.test(base)) return true;
  if (lower === ".github/copilot-instructions.md") return true;
  return /^\.cursor\/rules\//.test(lower);
}

function isDocPath(p: string, type: FileType): boolean {
  if (type.category === "doc") return true;
  const lower = p.toLowerCase();
  const base = path.basename(lower);
  return base.startsWith("readme") || /(^|\/)docs?\//.test(lower) || /(^|\/)(adrs?|decisions)\//.test(lower);
}

const CONFIG_CODE = /(?:^|\/)(?:[\w.-]+\.config\.[cm]?[jt]s|\.eslintrc\.[cm]?js|\.prettierrc\.[cm]?js|setup\.py|conftest\.py|settings\.py|manage\.py|gulpfile\.[jt]s|gruntfile\.js)$/i;

function isMigrationPath(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    /(^|\/)(migrations?|migrate)\//.test(lower) ||
    /(^|\/)alembic\/versions\//.test(lower) ||
    (/(^|\/)drizzle\//.test(lower) && lower.endsWith(".sql"))
  );
}

/** Route files recognised from their path alone (Next.js app-router `route.*`, `pages/api/**`). */
export function isRoutePath(p: string): boolean {
  return /(^|\/)app\/(.*\/)?route\.[cm]?[jt]sx?$/.test(p) || /(^|\/)pages\/api\/.+\.[cm]?[jt]sx?$/.test(p);
}

/** Tags known from the path and type; content-derived tags (route, schema, generated) are added by the analyzer. */
export function classifyPath(p: string, type: FileType): FileTag[] {
  const tags = new Set<FileTag>();
  if (isTestPath(p)) tags.add("test");
  if (type.manifest) tags.add("manifest");
  if (type.ci) {
    tags.add("ci");
    tags.add("config");
  }
  if (isInstructionsPath(p)) tags.add("instructions");
  if (isDocPath(p, type) && type.category !== "config") tags.add("doc");
  if (type.category === "config" && !type.manifest) tags.add("config");
  if (type.category === "code" && CONFIG_CODE.test(p)) tags.add("config");
  if (path.basename(p).toLowerCase() === "openreview.json") tags.add("config");
  if (isMigrationPath(p)) tags.add("migration");
  if (/\.(prisma|graphql|gql|proto)$/i.test(p) || /(^|\/)schema\.(rb|sql)$/i.test(p)) tags.add("schema");
  if (isRoutePath(p)) tags.add("route");
  if (type.category === "code" && !tags.has("test") && !tags.has("config")) tags.add("source");
  return [...tags];
}

/** Header comments that mark a file as machine-generated. */
export function hasGeneratedHeader(text: string): boolean {
  const head = text.slice(0, 1024);
  return /@generated\b|Code generated .* DO NOT EDIT|<auto-generated|\bauto-?generated\b.*\bdo not (?:edit|modify)\b/i.test(head);
}

/** Languages counted in `repos.languages` (programming languages, not docs or config formats). */
export function isProgrammingLanguage(type: FileType): boolean {
  return type.category === "code";
}
