import { createRequire } from "node:module";
import path from "node:path";
import type * as TreeSitter from "@vscode/tree-sitter-wasm";
import { isTestPath } from "./filetypes";
import { LANGUAGES, languageForPath, type LanguageId, type LanguageSpec } from "./languages";
import { HTTP_METHODS, joinRoutePaths, nextRoutePath, normalizeRoutePath, routeName } from "./routes";

// The runtime and grammars ship together in @vscode/tree-sitter-wasm, so ABI versions always match.
const require = createRequire(import.meta.url);

type TreeSitterModule = typeof TreeSitter;
type Node = TreeSitter.Node;

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "struct"
  | "trait"
  | "variable"
  | "module"
  | "route"
  | "table"
  | "model"
  | "test"
  | "ci_job";

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  /** Source of the symbol (truncated). */
  content: string;
  /** First line of the definition. */
  signature: string;
  /** Name qualified by its parents, e.g. `Cart.total`. */
  qualifiedName: string;
  exported: boolean;
  /** Index of the enclosing symbol (method → class), or null. */
  parent: number | null;
}

/** A reference from symbol `from` (index, or null at module level) to a named target. */
export interface NamedEdge {
  name: string;
  line: number;
  from: number | null;
}

export interface ParsedFile {
  language: LanguageId;
  symbols: ParsedSymbol[];
  /** Call sites; `from` indexes the innermost enclosing symbol (or null at module level). */
  calls: NamedEdge[];
  imports: { target: string; line: number }[];
  /** Re-exported module specifiers (`export * from "./x"`). */
  exports: { target: string; line: number }[];
  /** Type / identifier references, deduplicated per (from, name). */
  references: NamedEdge[];
  heritage: (NamedEdge & { kind: "extends" | "implements" })[];
  /** Route symbol index → handler name. */
  routeHandlers: { route: number; handler: string; line: number }[];
}

const MAX_SYMBOL_CHARS = 4000;
const MAX_CALLS = 2000;
const MAX_REFERENCES = 400;
const MAX_IMPORTS = 500;

interface Loaded {
  language: TreeSitter.Language;
  definitions: TreeSitter.Query;
  calls: TreeSitter.Query;
  imports: TreeSitter.Query;
}

let runtime: Promise<TreeSitterModule> | undefined;
const loaded = new Map<LanguageId, Promise<Loaded>>();

function wasmDir() {
  return path.dirname(require.resolve("@vscode/tree-sitter-wasm"));
}

function ts(): Promise<TreeSitterModule> {
  runtime ??= (async () => {
    const mod = require("@vscode/tree-sitter-wasm") as TreeSitterModule;
    await mod.Parser.init({ locateFile: (file: string) => path.join(wasmDir(), file) });
    return mod;
  })();
  return runtime;
}

function load(spec: LanguageSpec): Promise<Loaded> {
  let entry = loaded.get(spec.id);
  if (!entry) {
    entry = (async () => {
      const mod = await ts();
      const language = await mod.Language.load(path.join(wasmDir(), spec.wasm));
      return {
        language,
        definitions: new mod.Query(language, spec.definitions),
        calls: new mod.Query(language, spec.calls),
        imports: new mod.Query(language, spec.imports),
      };
    })();
    loaded.set(spec.id, entry);
  }
  return entry;
}

/** Loads every grammar and compiles every query; throws if any query is invalid. */
export async function warmUpParsers() {
  await Promise.all(LANGUAGES.map(load));
}

function cleanImport(lang: LanguageId, text: string): string {
  const t = text.trim();
  if (lang === "go") return t.replace(/^["`]|["`]$/g, "");
  if (lang === "rust") return t.replace(/\s+/g, "").replace(/::\{.*$/, "").replace(/::\*$/, "");
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// Node helpers

function kids(node: Node): Node[] {
  return node.namedChildren.filter((n): n is Node => n !== null);
}

function fieldOf(node: Node): string | null {
  const parent = node.parent;
  if (!parent) return null;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
  }
  return null;
}

/** Literal value of a string node, or null for interpolated / non-string nodes. */
function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "template_string" && kids(node).some((k) => k.type === "template_substitution")) return null;
  const m = /^[A-Za-z@$]*("""|'''|"|'|`)([\s\S]*)\1$/.exec(node.text.trim());
  return m ? m[2]! : null;
}

/** Last identifier segment of a name-ish node (`a.b.C` → `C`, `Base<T>` → `Base`). */
function baseName(node: Node | null | undefined): string | null {
  if (!node) return null;
  const t = node.text.replace(/<[\s\S]*$/, "").replace(/\[[\s\S]*$/, "").replace(/\([\s\S]*$/, "").trim();
  const seg = t.split(/::|\.|\\/).pop() ?? "";
  return /^[A-Za-z_$][\w$]*$/.test(seg) ? seg : null;
}

const BUILTIN_TYPES = new Set(
  (
    "string number boolean any unknown void never object bigint symbol undefined null " +
    "String Number Boolean Object Function Symbol BigInt Array ReadonlyArray Promise PromiseLike Record Partial Required " +
    "Readonly Pick Omit Exclude Extract NonNullable ReturnType Parameters InstanceType Awaited Map Set WeakMap WeakSet " +
    "Date Error RegExp JSON Math Iterable Iterator AsyncIterable Generator Buffer Uint8Array " +
    "int str float bool bytes list dict tuple set frozenset type None Optional List Dict Tuple Set Any Union Callable " +
    "Self self cls Exception ValueError TypeError KeyError error rune byte int8 int16 int32 int64 uint uint8 uint16 " +
    "uint32 uint64 float32 float64 complex64 complex128 uintptr Integer Long Double Float Short Byte Character Void " +
    "Override Deprecated Vec Option Result Box Rc Arc RefCell Cell HashMap HashSet BTreeMap String Some Ok Err " +
    "Task IEnumerable IList ICollection IDictionary Action Func Guid DateTime TimeSpan var dynamic"
  ).split(" "),
);

// ---------------------------------------------------------------------------------------------------------------
// Drafts: symbols and edges collected before ordering, parents, and enclosing scopes are resolved.

interface Draft {
  name: string;
  kind: SymbolKind;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  exported: boolean;
  /** Calls, references, and nested symbols inside it belong to it. */
  container: boolean;
  parentMode: "auto" | "none" | "explicit";
  explicitParent?: Draft;
  /** Go receiver / Rust impl type, used for parent lookup and qualified names. */
  receiver?: string;
  /** Private member (TS `private`/`#x`, Python `_x`); never exported. */
  private?: boolean;
}

/** Syntax node each draft was created from. */
const nodeOf = new WeakMap<Draft, Node>();

interface OffsetEdge {
  name: string;
  line: number;
  offset: number;
}

class Extraction {
  drafts: Draft[] = [];
  byNode = new Map<number, Draft>();
  defNameStarts = new Set<number>();
  references: OffsetEdge[] = [];
  heritage: { kind: "extends" | "implements"; name: string; line: number; from: Draft }[] = [];
  routeHandlers: { route: Draft; handler: string; line: number }[] = [];
  exports: { target: string; line: number }[] = [];
  exportedNames = new Set<string>();
  /** Offsets of callee nodes that define symbols (`test(...)`), which are not real call edges. */
  definingCallees = new Set<number>();

  constructor(
    readonly filePath: string,
    readonly isTest: boolean,
    readonly source: string,
  ) {}

  add(node: Node, name: string, kind: SymbolKind, opts: Partial<Draft> = {}): Draft {
    const d: Draft = {
      name,
      kind,
      start: node.startIndex,
      end: node.endIndex,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      exported: false,
      container: !["route", "table"].includes(kind),
      parentMode: kind === "route" ? "none" : "auto",
      ...opts,
    };
    this.drafts.push(d);
    nodeOf.set(d, node);
    return d;
  }

  route(node: Node, method: string, routePath: string, handler: string | null, handlerLine?: number): Draft {
    const d = this.add(node, routeName(method, routePath), "route");
    if (handler) this.routeHandlers.push({ route: d, handler, line: handlerLine ?? d.startLine });
    return d;
  }

  extendsEdge(from: Draft | undefined, node: Node | null | undefined, kind: "extends" | "implements" = "extends") {
    const name = baseName(node);
    if (from && node && name) this.heritage.push({ kind, name, line: node.startPosition.row + 1, from });
  }

  reference(node: Node, name = node.text) {
    if (name.length < 2 || BUILTIN_TYPES.has(name) || this.defNameStarts.has(node.startIndex)) return;
    this.references.push({ name, line: node.startPosition.row + 1, offset: node.startIndex });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// TypeScript / JavaScript

const JS_ROUTE_RECEIVER = /^(?:app|router|server|fastify|api|routes?|\w+Router|\w+App|\w+Routes)$/;
const JS_ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const JS_FRAMEWORK_HINT = /\b(?:express|koa|@koa\/router|koa-router|fastify|hono|Router\(\))/;
const JS_TEST_CALLEE = /^(?:describe|it|test|suite|context|specify)(?:\.(?:only|skip|concurrent|todo|failing|sequential|each))*$/;
const DRIZZLE_TABLE = /^(?:pgTable|mysqlTable|sqliteTable)$/;

function isPrivateMember(node: Node): boolean {
  if (node.childForFieldName("name")?.type === "private_property_identifier") return true;
  return kids(node).some((k) => k.type === "accessibility_modifier" && k.text !== "public");
}

function decoratorsOf(cls: Node): Node[] {
  const own = kids(cls).filter((k) => k.type === "decorator");
  const parent = cls.parent;
  const outer = parent?.type === "export_statement" ? kids(parent).filter((k) => k.type === "decorator") : [];
  return [...outer, ...own];
}

function decoratorCall(dec: Node): { name: string; args: Node[] } | null {
  const inner = kids(dec)[0];
  if (!inner) return null;
  if (inner.type === "call_expression") {
    const name = baseName(inner.childForFieldName("function"));
    const args = inner.childForFieldName("arguments");
    return name ? { name, args: args ? kids(args) : [] } : null;
  }
  const name = baseName(inner);
  return name ? { name, args: [] } : null;
}

function extractJs(x: Extraction, root: Node) {
  const isJsExported = (def: Node) => {
    const p = def.parent;
    if (p?.type === "export_statement") return true;
    return (p?.type === "lexical_declaration" || p?.type === "variable_declaration") && p.parent?.type === "export_statement";
  };
  for (const d of x.drafts) {
    const node = nodeOf.get(d);
    if (!node) continue;
    if (node.type === "method_definition") d.private = isPrivateMember(node);
    else d.exported = isJsExported(node);
  }

  // Exported plain variables (functions are already definitions).
  for (const stmt of kids(root).filter((k) => k.type === "export_statement")) {
    const decl = stmt.childForFieldName("declaration");
    if (decl && (decl.type === "lexical_declaration" || decl.type === "variable_declaration")) {
      for (const v of kids(decl).filter((k) => k.type === "variable_declarator")) {
        const name = v.childForFieldName("name");
        const value = v.childForFieldName("value");
        if (name?.type !== "identifier" || x.byNode.has(v.id)) continue;
        if (value && ["arrow_function", "function_expression", "function"].includes(value.type)) continue;
        x.defNameStarts.add(name.startIndex);
        x.byNode.set(v.id, x.add(v, name.text, "variable", { exported: true }));
      }
    }
    const source = stmt.childForFieldName("source");
    const clause = kids(stmt).find((k) => k.type === "export_clause");
    if (source) {
      const target = stringValue(source);
      if (target) x.exports.push({ target, line: stmt.startPosition.row + 1 });
    } else if (clause) {
      for (const spec of kids(clause)) {
        const n = spec.childForFieldName("name");
        if (n) x.exportedNames.add(n.text);
      }
    }
  }

  // CommonJS: module.exports = { a, b } / module.exports = a / exports.a = ...
  for (const asg of root.descendantsOfType("assignment_expression")) {
    if (!asg) continue;
    const left = asg.childForFieldName("left")?.text ?? "";
    const right = asg.childForFieldName("right");
    if (left === "module.exports" && right) {
      if (right.type === "identifier") x.exportedNames.add(right.text);
      if (right.type === "object") {
        for (const p of kids(right)) {
          if (p.type === "shorthand_property_identifier") x.exportedNames.add(p.text);
          if (p.type === "pair") {
            const v = p.childForFieldName("value");
            if (v?.type === "identifier") x.exportedNames.add(v.text);
          }
        }
      }
    }
    const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
    if (m && right?.type === "identifier") x.exportedNames.add(right.text);
  }

  // Classes: heritage and TypeORM entities.
  for (const cls of root.descendantsOfType(["class_declaration", "abstract_class_declaration", "class"])) {
    if (!cls) continue;
    const d = x.byNode.get(cls.id);
    if (!d) continue;
    const heritage = kids(cls).find((k) => k.type === "class_heritage");
    if (heritage) {
      for (const clause of kids(heritage)) {
        if (clause.type === "extends_clause") x.extendsEdge(d, clause.childForFieldName("value"));
        else if (clause.type === "implements_clause") for (const t of kids(clause)) x.extendsEdge(d, t, "implements");
        else x.extendsEdge(d, clause); // JavaScript: class_heritage holds the expression directly
      }
    }
    for (const dec of decoratorsOf(cls)) {
      const call = decoratorCall(dec);
      if (call?.name !== "Entity") continue;
      d.kind = "model";
      const table = stringValue(call.args[0]);
      if (table) x.add(dec, table, "table", { explicitParent: d, parentMode: "explicit" });
    }
  }
  for (const iface of root.descendantsOfType("interface_declaration")) {
    if (!iface) continue;
    const d = x.byNode.get(iface.id);
    const ext = kids(iface).find((k) => k.type === "extends_type_clause");
    if (d && ext) for (const t of kids(ext)) x.extendsEdge(d, t);
  }

  // Calls that define tests, tables, and routes.
  const route = nextRoutePath(x.filePath);
  const frameworkHint = JS_FRAMEWORK_HINT.test(x.source);
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    const argsNode = call.childForFieldName("arguments");
    if (!fn || !argsNode) continue;
    const args = kids(argsNode);
    const callee = fn.text;
    if (x.isTest && JS_TEST_CALLEE.test(callee)) {
      const title = stringValue(args[0]);
      if (title === null) continue;
      x.add(call, title, "test");
      x.definingCallees.add(fn.startIndex);
      const property = fn.type === "member_expression" ? fn.childForFieldName("property") : null;
      if (property) x.definingCallees.add(property.startIndex);
      continue;
    }
    if (fn.type === "identifier" && DRIZZLE_TABLE.test(callee)) {
      const table = stringValue(args[0]);
      if (table) x.add(call, table, "table");
      continue;
    }
    if (frameworkHint && fn.type === "member_expression") {
      const receiver = fn.childForFieldName("object");
      const method = fn.childForFieldName("property")?.text ?? "";
      const p = stringValue(args[0]);
      if (receiver?.type === "identifier" && JS_ROUTE_RECEIVER.test(receiver.text) && JS_ROUTE_METHODS.has(method) && p !== null && /^[/*]/.test(p) && args.length >= 2) {
        const last = args[args.length - 1]!;
        const handler = last.type === "identifier" || last.type === "member_expression" ? baseName(last) : null;
        x.route(call, method === "all" ? "ANY" : method, p, handler, last.startPosition.row + 1);
      }
    }
  }

  // Next.js route handlers.
  if (route?.style === "app") {
    for (const d of [...x.drafts]) {
      const isHandler = (d.kind === "function" || d.kind === "variable") && (d.exported || x.exportedNames.has(d.name));
      if (isHandler && (HTTP_METHODS as readonly string[]).includes(d.name)) {
        const node = nodeOf.get(d);
        if (node) x.route(node, d.name, route.path, d.name);
      }
    }
  } else if (route?.style === "pages") {
    for (const stmt of kids(root).filter((k) => k.type === "export_statement" && /^export\s+default\b/.test(k.text))) {
      const decl = stmt.childForFieldName("declaration") ?? stmt.childForFieldName("value") ?? kids(stmt)[0];
      const handler = decl?.type === "identifier" ? decl.text : decl ? baseName(decl.childForFieldName("name")) : null;
      x.route(stmt, "ANY", route.path, handler);
    }
  }

  // References: types, plus identifiers bound by imports.
  const bindings = new Set<string>();
  for (const imp of root.descendantsOfType(["import_specifier", "import_clause", "namespace_import"])) {
    if (!imp) continue;
    if (imp.type === "import_specifier") {
      const n = imp.childForFieldName("alias") ?? imp.childForFieldName("name");
      if (n) bindings.add(n.text);
    } else {
      for (const k of kids(imp)) if (k.type === "identifier") bindings.add(k.text);
    }
  }
  for (const decl of root.descendantsOfType("variable_declarator")) {
    const value = decl?.childForFieldName("value");
    if (!decl || value?.type !== "call_expression" || value.childForFieldName("function")?.text !== "require") continue;
    const name = decl.childForFieldName("name");
    if (name?.type === "identifier") bindings.add(name.text);
    if (name?.type === "object_pattern") for (const k of kids(name)) if (k.type === "shorthand_property_identifier_pattern") bindings.add(k.text);
  }
  for (const node of root.descendantsOfType(["type_identifier", "identifier"])) {
    if (!node) continue;
    if (node.type === "identifier") {
      if (!bindings.has(node.text)) continue;
      const parentType = node.parent?.type ?? "";
      if (["import_specifier", "import_clause", "namespace_import", "export_specifier", "variable_declarator"].includes(parentType)) continue;
      const f = fieldOf(node);
      if ((parentType === "call_expression" && f === "function") || (parentType === "new_expression" && f === "constructor")) continue;
    }
    x.reference(node);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Python

const PY_ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "route", "api_route", "websocket"]);

function pyKeyword(args: Node[], key: string): Node | null {
  for (const a of args) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === key) return a.childForFieldName("value");
  }
  return null;
}

function extractPython(x: Extraction, root: Node) {
  for (const d of x.drafts) {
    const node = nodeOf.get(d);
    if (!node) continue;
    d.private = d.name.startsWith("_");
    d.exported = !d.private && node.parent?.type === "module";
    if (node.parent?.type === "decorated_definition" && node.parent.parent?.type === "module") d.exported = !d.private;
    if (x.isTest && node.type === "function_definition" && /^test/.test(d.name)) d.kind = "test";
  }

  // Module-level assignments are importable names.
  for (const stmt of kids(root).filter((k) => k.type === "expression_statement")) {
    const asg = kids(stmt)[0];
    const left = asg?.type === "assignment" ? asg.childForFieldName("left") : null;
    if (!asg || left?.type !== "identifier" || left.text.startsWith("_")) continue;
    x.defNameStarts.add(left.startIndex);
    x.byNode.set(stmt.id, x.add(stmt, left.text, "variable", { exported: true }));
  }

  // Router prefixes: router = APIRouter(prefix="/users"), bp = Blueprint("x", __name__, url_prefix="/x").
  const prefixes = new Map<string, string>();
  for (const asg of root.descendantsOfType("assignment")) {
    const left = asg?.childForFieldName("left");
    const right = asg?.childForFieldName("right");
    if (!asg || left?.type !== "identifier" || right?.type !== "call") continue;
    const ctor = baseName(right.childForFieldName("function"));
    const args = kids(right.childForFieldName("arguments") ?? right);
    if (ctor === "APIRouter") prefixes.set(left.text, stringValue(pyKeyword(args, "prefix")) ?? "");
    if (ctor === "Blueprint") prefixes.set(left.text, stringValue(pyKeyword(args, "url_prefix")) ?? "");
  }

  for (const cls of root.descendantsOfType("class_definition")) {
    if (!cls) continue;
    const d = x.byNode.get(cls.id);
    if (!d) continue;
    const supers = cls.childForFieldName("superclasses");
    for (const s of supers ? kids(supers) : []) {
      if (s.type === "keyword_argument") continue;
      x.extendsEdge(d, s);
      if (s.text === "models.Model") d.kind = "model";
    }
    const body = cls.childForFieldName("body");
    for (const stmt of body ? kids(body) : []) {
      const asg = kids(stmt)[0];
      if (stmt.type !== "expression_statement" || asg?.type !== "assignment" || asg.childForFieldName("left")?.text !== "__tablename__") continue;
      const table = stringValue(asg.childForFieldName("right"));
      d.kind = "model";
      if (table) x.add(stmt, table, "table", { explicitParent: d, parentMode: "explicit" });
    }
  }

  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    const args = kids(call.childForFieldName("arguments") ?? call);
    if (fn?.text === "Table" || fn?.text === "sa.Table" || fn?.text === "sqlalchemy.Table") {
      const table = stringValue(args[0]);
      if (table) x.add(call, table, "table");
    }
    if (/(^|\/)urls\.py$/.test(x.filePath) && (fn?.text === "path" || fn?.text === "re_path")) {
      const p = stringValue(args[0]);
      const view = args[1];
      if (p === null || !view) continue;
      const target = view.type === "call" ? view.childForFieldName("function")?.childForFieldName("object") : view;
      x.route(call, "ANY", p.replace(/^\^|\$$/g, ""), baseName(target));
    }
  }

  for (const dec of root.descendantsOfType("decorated_definition")) {
    if (!dec) continue;
    const def = dec.childForFieldName("definition");
    const handler = def?.childForFieldName("name")?.text;
    if (!def || !handler) continue;
    for (const decorator of kids(dec).filter((k) => k.type === "decorator")) {
      const call = kids(decorator)[0];
      const fn = call?.type === "call" ? call.childForFieldName("function") : null;
      if (!call || fn?.type !== "attribute") continue;
      const method = fn.childForFieldName("attribute")?.text ?? "";
      const receiver = fn.childForFieldName("object")?.text ?? "";
      if (!PY_ROUTE_METHODS.has(method)) continue;
      const args = kids(call.childForFieldName("arguments") ?? call);
      const p = stringValue(args[0]);
      if (p === null) continue;
      const full = joinRoutePaths(prefixes.get(receiver) ?? "", p);
      let methods = [method === "websocket" ? "WS" : method.toUpperCase()];
      if (method === "route" || method === "api_route") {
        const list = pyKeyword(args, "methods");
        methods = list ? kids(list).map((m) => stringValue(m)?.toUpperCase()).filter((m): m is string => !!m) : ["GET"];
        if (methods.length === 0) methods = ["GET"];
      }
      for (const m of methods) x.route(def, m, full, handler);
    }
  }

  const bindings = new Set<string>();
  for (const imp of root.descendantsOfType(["import_from_statement", "import_statement"])) {
    if (!imp) continue;
    const names = imp.childrenForFieldName("name").filter((n): n is Node => n !== null);
    for (const n of names) {
      if (n.type === "aliased_import") bindings.add(n.childForFieldName("alias")?.text ?? "");
      else if (imp.type === "import_from_statement") bindings.add(n.text.split(".").pop() ?? "");
      else bindings.add(n.text.split(".")[0] ?? "");
    }
  }
  for (const node of root.descendantsOfType("identifier")) {
    if (!node) continue;
    const inType = (() => {
      for (let p = node.parent; p; p = p.parent) {
        if (p.type === "type") return true;
        if (p.type === "function_definition" || p.type === "class_definition" || p.type === "block") return false;
      }
      return false;
    })();
    if (!inType && !bindings.has(node.text)) continue;
    const parentType = node.parent?.type ?? "";
    if (["dotted_name", "aliased_import", "import_from_statement", "import_statement"].includes(parentType)) continue;
    if (parentType === "call" && fieldOf(node) === "function") continue;
    if (parentType === "attribute" && fieldOf(node) === "attribute") continue;
    x.reference(node);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Go

const GO_ROUTE_FUNCS = new Set(["HandleFunc", "Handle", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "Any"]);

function extractGo(x: Extraction, root: Node) {
  for (const d of x.drafts) {
    const node = nodeOf.get(d);
    d.exported = /^[A-Z]/.test(d.name);
    if (!node) continue;
    if (node.type === "method_declaration") {
      const recv = node.childForFieldName("receiver");
      const typeNode = recv?.descendantsOfType("type_identifier")[0];
      if (typeNode) d.receiver = typeNode.text;
    }
    if (x.isTest && node.type === "function_declaration" && /^(?:Test|Benchmark|Fuzz|Example)/.test(d.name)) d.kind = "test";
    if (node.type === "type_declaration") {
      const spec = kids(node).find((k) => k.type === "type_spec" && k.childForFieldName("name")?.text === d.name);
      const t = spec?.childForFieldName("type");
      if (t?.type === "struct_type") {
        for (const field of t.descendantsOfType("field_declaration")) {
          if (field && !field.childForFieldName("name")) x.extendsEdge(d, field.childForFieldName("type"));
        }
      } else if (t?.type === "interface_type") {
        for (const el of kids(t).filter((k) => k.type === "type_elem")) x.extendsEdge(d, kids(el)[0]);
      }
    }
  }

  for (const decl of kids(root).filter((k) => k.type === "const_declaration" || k.type === "var_declaration")) {
    for (const spec of decl.descendantsOfType(["const_spec", "var_spec"])) {
      if (!spec) continue;
      for (const n of spec.childrenForFieldName("name")) {
        if (!n || !/^[A-Z]/.test(n.text)) continue;
        x.defNameStarts.add(n.startIndex);
        x.add(spec, n.text, "variable", { exported: true });
      }
    }
  }

  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "selector_expression") continue;
    const name = fn.childForFieldName("field")?.text ?? "";
    if (!GO_ROUTE_FUNCS.has(name)) continue;
    const args = kids(call.childForFieldName("arguments") ?? call);
    const pattern = stringValue(args[0]);
    if (pattern === null || args.length < 2) continue;
    let method = name === "HandleFunc" || name === "Handle" ? "ANY" : name.toUpperCase();
    let p = pattern;
    const m = /^([A-Z]+)\s+(\/.*)$/.exec(pattern);
    if (m) {
      method = m[1]!;
      p = m[2]!;
    }
    if (!p.startsWith("/")) continue;
    const last = args[args.length - 1]!;
    const handler = last.type === "identifier" || last.type === "selector_expression" ? baseName(last) : null;
    x.route(call, method, p, handler, last.startPosition.row + 1);
  }

  for (const node of root.descendantsOfType("type_identifier")) {
    if (!node || node.parent?.type === "type_spec") continue;
    x.reference(node);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Java

const SPRING_MAPPINGS: Record<string, string | null> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
  RequestMapping: null,
};

function javaAnnotations(node: Node): { name: string; args: Node | null }[] {
  const mods = kids(node).find((k) => k.type === "modifiers");
  if (!mods) return [];
  return kids(mods)
    .filter((k) => k.type === "annotation" || k.type === "marker_annotation")
    .map((a) => ({ name: baseName(a.childForFieldName("name")) ?? "", args: a.childForFieldName("arguments") }));
}

function javaModifiers(node: Node): string {
  return kids(node).find((k) => k.type === "modifiers")?.text ?? "";
}

/** `@X("/p")`, `@X(value = "/p")`, `@X(path = {"/p"})` → "/p"; plus `method = RequestMethod.GET`. */
function annotationArgs(args: Node | null): { path: string | null; method: string | null; name: string | null } {
  if (!args) return { path: null, method: null, name: null };
  let p: string | null = null;
  let method: string | null = null;
  let name: string | null = null;
  for (const a of kids(args)) {
    if (a.type === "element_value_pair") {
      const key = a.childForFieldName("key")?.text;
      const value = a.childForFieldName("value");
      const str = stringValue(value) ?? (value?.type === "element_value_array_initializer" ? stringValue(kids(value)[0]) : null);
      if (key === "value" || key === "path") p = str;
      if (key === "name") name = str;
      if (key === "method") method = baseName(value?.type === "element_value_array_initializer" ? kids(value)[0] : value);
    } else {
      p ??= stringValue(a) ?? (a.type === "element_value_array_initializer" ? stringValue(kids(a)[0]) : null);
    }
  }
  return { path: p, method, name };
}

function extractJava(x: Extraction, root: Node) {
  for (const d of x.drafts) {
    const node = nodeOf.get(d);
    if (!node) continue;
    const inInterface = node.parent?.parent?.type === "interface_declaration";
    d.exported = /\bpublic\b/.test(javaModifiers(node)) || inInterface;
    if (node.type === "method_declaration" && javaAnnotations(node).some((a) => /^(?:Test|ParameterizedTest|RepeatedTest|TestFactory)$/.test(a.name))) {
      d.kind = "test";
    }
  }

  for (const cls of root.descendantsOfType(["class_declaration", "interface_declaration", "record_declaration", "enum_declaration"])) {
    if (!cls) continue;
    const d = x.byNode.get(cls.id);
    if (!d) continue;
    const sup = cls.childForFieldName("superclass");
    if (sup) x.extendsEdge(d, kids(sup)[0]);
    const ifaces = cls.childForFieldName("interfaces");
    for (const t of ifaces?.descendantsOfType(["type_identifier", "generic_type"]) ?? []) {
      if (t && t.parent?.type === "type_list") x.extendsEdge(d, t, "implements");
    }
    const ext = kids(cls).find((k) => k.type === "extends_interfaces");
    for (const t of ext?.descendantsOfType(["type_identifier", "generic_type"]) ?? []) {
      if (t && t.parent?.type === "type_list") x.extendsEdge(d, t);
    }

    const annotations = javaAnnotations(cls);
    if (annotations.some((a) => a.name === "Entity")) {
      d.kind = "model";
      const table = annotations.find((a) => a.name === "Table");
      const tableName = table ? annotationArgs(table.args).name : null;
      if (tableName) x.add(cls, tableName, "table", { explicitParent: d, parentMode: "explicit" });
    }
    const classMapping = annotations.find((a) => a.name === "RequestMapping" || a.name === "Path");
    const prefix = classMapping ? (annotationArgs(classMapping.args).path ?? "") : "";
    const body = cls.childForFieldName("body");
    for (const m of body ? kids(body).filter((k) => k.type === "method_declaration") : []) {
      const handler = m.childForFieldName("name")?.text;
      if (!handler) continue;
      for (const a of javaAnnotations(m)) {
        if (!(a.name in SPRING_MAPPINGS)) continue;
        const args = annotationArgs(a.args);
        const method = SPRING_MAPPINGS[a.name] ?? args.method ?? "ANY";
        x.route(m, method, joinRoutePaths(prefix, args.path ?? ""), handler);
      }
    }
  }

  for (const field of root.descendantsOfType("field_declaration")) {
    if (!field) continue;
    const mods = javaModifiers(field);
    if (!/\bpublic\b/.test(mods) || !/\bstatic\b/.test(mods)) continue;
    for (const v of field.childrenForFieldName("declarator")) {
      const n = v?.childForFieldName("name");
      if (!n) continue;
      x.defNameStarts.add(n.startIndex);
      x.add(field, n.text, "variable", { exported: true });
    }
  }

  for (const node of root.descendantsOfType(["type_identifier", "identifier"])) {
    if (!node) continue;
    if (node.type === "identifier") {
      const parentType = node.parent?.type ?? "";
      const isObject = (parentType === "method_invocation" || parentType === "field_access") && fieldOf(node) === "object";
      if (!isObject || !/^[A-Z]/.test(node.text)) continue;
    } else if (node.parent?.type === "type_list" || node.parent?.type === "superclass") {
      continue; // heritage edges cover these
    }
    x.reference(node);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// C#

const ASPNET_VERBS: Record<string, string> = {
  HttpGet: "GET",
  HttpPost: "POST",
  HttpPut: "PUT",
  HttpDelete: "DELETE",
  HttpPatch: "PATCH",
  HttpHead: "HEAD",
  HttpOptions: "OPTIONS",
};
const MINIMAL_API: Record<string, string> = { MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapDelete: "DELETE", MapPatch: "PATCH", MapMethods: "ANY" };

function csAttributes(node: Node): { name: string; arg: string | null }[] {
  const out: { name: string; arg: string | null }[] = [];
  for (const list of kids(node).filter((k) => k.type === "attribute_list")) {
    for (const attr of kids(list).filter((k) => k.type === "attribute")) {
      const name = baseName(attr.childForFieldName("name")) ?? "";
      const argList = kids(attr).find((k) => k.type === "attribute_argument_list");
      const first = argList ? kids(argList)[0] : undefined;
      const literal = first ? first.descendantsOfType(["string_literal", "verbatim_string_literal"])[0] : null;
      out.push({ name: name.replace(/Attribute$/, ""), arg: stringValue(literal) });
    }
  }
  return out;
}

function csModifiers(node: Node): string[] {
  return kids(node)
    .filter((k) => k.type === "modifier")
    .map((k) => k.text);
}

function extractCSharp(x: Extraction, root: Node) {
  for (const d of x.drafts) {
    const node = nodeOf.get(d);
    if (!node) continue;
    const inInterface = node.parent?.parent?.type === "interface_declaration";
    d.exported = csModifiers(node).includes("public") || inInterface;
    if (node.type === "method_declaration" && csAttributes(node).some((a) => /^(?:Fact|Theory|Test|TestMethod|TestCase)$/.test(a.name))) d.kind = "test";
  }

  for (const cls of root.descendantsOfType(["class_declaration", "interface_declaration", "struct_declaration", "record_declaration"])) {
    if (!cls) continue;
    const d = x.byNode.get(cls.id);
    if (!d) continue;
    const bases = kids(cls).find((k) => k.type === "base_list");
    // C# does not mark base classes vs interfaces; the first non-`I*` base is the class. The graph resolver
    // corrects the kind once the target symbol's kind is known.
    (bases ? kids(bases) : []).forEach((b, i) => {
      const name = baseName(b);
      const kind = cls.type === "interface_declaration" || (i === 0 && name && !/^I[A-Z]/.test(name)) ? "extends" : "implements";
      x.extendsEdge(d, b, kind);
    });

    const attrs = csAttributes(cls);
    const controller = d.name.replace(/Controller$/, "");
    const prefix = (attrs.find((a) => a.name === "Route")?.arg ?? "").replace(/\[controller\]/gi, controller);
    const body = cls.childForFieldName("body");
    for (const m of body ? kids(body).filter((k) => k.type === "method_declaration") : []) {
      const handler = m.childForFieldName("name")?.text;
      if (!handler) continue;
      const mAttrs = csAttributes(m);
      const methodRoute = mAttrs.find((a) => a.name === "Route")?.arg ?? null;
      const resolve = (template: string | null) => {
        const t = (template ?? methodRoute ?? "").replace(/\[action\]/gi, handler);
        return t.startsWith("/") || t.startsWith("~/") ? normalizeRoutePath(t) : joinRoutePaths(prefix, t);
      };
      const verbs = mAttrs.filter((a) => a.name in ASPNET_VERBS);
      for (const v of verbs) x.route(m, ASPNET_VERBS[v.name]!, resolve(v.arg), handler);
      if (verbs.length === 0 && methodRoute !== null) x.route(m, "ANY", resolve(null), handler);
    }
  }

  for (const call of root.descendantsOfType("invocation_expression")) {
    const fn = call?.childForFieldName("function");
    if (!call || fn?.type !== "member_access_expression") continue;
    const verb = MINIMAL_API[fn.childForFieldName("name")?.text ?? ""];
    if (!verb) continue;
    const args = kids(call.childForFieldName("arguments") ?? call).map((a) => kids(a)[0] ?? a);
    const p = stringValue(args[0]);
    if (p === null || args.length < 2) continue;
    const last = args[args.length - 1]!;
    const handler = last.type === "identifier" || last.type === "member_access_expression" ? baseName(last) : null;
    x.route(call, verb, p, handler, last.startPosition.row + 1);
  }

  for (const field of root.descendantsOfType("field_declaration")) {
    if (!field) continue;
    const mods = csModifiers(field);
    if (!mods.includes("public") || !(mods.includes("const") || mods.includes("static"))) continue;
    for (const v of field.descendantsOfType("variable_declarator")) {
      const n = v?.childForFieldName("name");
      if (!n) continue;
      x.defNameStarts.add(n.startIndex);
      x.add(field, n.text, "variable", { exported: true });
    }
  }

  for (const node of root.descendantsOfType("identifier")) {
    if (!node) continue;
    const parentType = node.parent?.type ?? "";
    const f = fieldOf(node);
    const typePosition =
      f === "type" ||
      f === "returns" ||
      ["type_argument_list", "array_type", "nullable_type", "type_parameter_constraint"].includes(parentType) ||
      (parentType === "member_access_expression" && f === "expression" && /^[A-Z]/.test(node.text));
    if (!typePosition || parentType === "base_list") continue;
    x.reference(node);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rust

function extractRust(x: Extraction, root: Node) {
  for (const d of x.drafts) {
    const node = nodeOf.get(d);
    if (!node) continue;
    d.exported = kids(node).some((k) => k.type === "visibility_modifier");
    const owner = node.parent?.type === "declaration_list" ? node.parent.parent : null;
    if (owner && (owner.type === "impl_item" || owner.type === "trait_item") && d.kind === "function") {
      d.kind = "method";
      d.receiver = baseName(owner.type === "impl_item" ? owner.childForFieldName("type") : owner.childForFieldName("name")) ?? undefined;
      if (owner.type === "trait_item") d.exported = true;
    }
    if (node.type === "function_item") {
      for (let prev = node.previousNamedSibling; prev?.type === "attribute_item"; prev = prev.previousNamedSibling) {
        if (/^#\[(?:[\w:]+::)?test\b/.test(prev.text)) d.kind = "test";
      }
    }
  }

  for (const item of kids(root).filter((k) => k.type === "const_item" || k.type === "static_item")) {
    const n = item.childForFieldName("name");
    if (!n || !kids(item).some((k) => k.type === "visibility_modifier")) continue;
    x.defNameStarts.add(n.startIndex);
    x.add(item, n.text, "variable", { exported: true });
  }

  const typesByName = new Map(x.drafts.filter((d) => ["struct", "enum", "type", "class"].includes(d.kind)).map((d) => [d.name, d]));
  const heritageNodes = new Set<number>();
  for (const impl of root.descendantsOfType("impl_item")) {
    if (!impl) continue;
    const trait = impl.childForFieldName("trait");
    const type = impl.childForFieldName("type");
    if (trait) heritageNodes.add(trait.startIndex);
    if (type) heritageNodes.add(type.startIndex);
    const from = typesByName.get(baseName(type) ?? "");
    if (trait && from) x.extendsEdge(from, trait, "implements");
  }

  for (const node of root.descendantsOfType(["type_identifier", "identifier"])) {
    if (!node || heritageNodes.has(node.startIndex)) continue;
    if (node.type === "identifier") {
      const isPath = node.parent?.type === "scoped_identifier" && fieldOf(node) === "path";
      if (!isPath || !/^[A-Z]/.test(node.text)) continue;
    }
    x.reference(node);
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** Kinds named globally (a route or table is not "inside" the variable that declares it). */
const UNQUALIFIED_KINDS = new Set<SymbolKind>(["route", "table", "module", "ci_job"]);
const UNEXPORTED_KINDS = new Set<SymbolKind>(["test", "route", "table", "ci_job"]);

/** First line of the declaration itself, skipping decorators / annotations / attributes. */
export function signatureOf(content: string): string {
  const lines = content.split("\n").filter((l) => l.trim());
  const decl = lines.find((l) => !/^\s*(?:@[\w.]+|\[[A-Z][\w.]*(?:\(|\]|,)|#\[)/.test(l)) ?? lines[0] ?? "";
  return decl.trim().slice(0, 200);
}

/**
 * Innermost span (by index) containing each offset. Spans form a laminar family (tree nodes), so one sweep with a
 * stack answers every query in O((spans + offsets) log n).
 */
function innermostContaining(spans: { start: number; end: number; index: number }[], offsets: number[]): (number | null)[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const order = offsets.map((o, i) => [o, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number | null>(offsets.length).fill(null);
  const stack: typeof sorted = [];
  let si = 0;
  for (const [off, qi] of order) {
    while (si < sorted.length && sorted[si]!.start <= off) {
      const s = sorted[si++]!;
      while (stack.length && stack[stack.length - 1]!.end <= s.start) stack.pop();
      stack.push(s);
    }
    while (stack.length && stack[stack.length - 1]!.end <= off) stack.pop();
    out[qi] = stack.length ? stack[stack.length - 1]!.index : null;
  }
  return out;
}

export async function parseSource(filePath: string, source: string, opts: { isTest?: boolean } = {}): Promise<ParsedFile | null> {
  const spec = languageForPath(filePath);
  if (!spec) return null;
  const mod = await ts();
  const q = await load(spec);
  const parser: TreeSitter.Parser = new mod.Parser();
  parser.setLanguage(q.language);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    return null;
  }
  try {
    const root = tree.rootNode;
    const lines = source.split("\n");
    const x = new Extraction(filePath, opts.isTest ?? isTestPath(filePath), source);

    const seen = new Set<string>();
    for (const match of q.definitions.matches(root)) {
      const def = match.captures.find((c) => c.name.startsWith("def."));
      const name = match.captures.find((c) => c.name === "name");
      if (!def || !name) continue;
      const key = `${name.node.text}:${def.node.startIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      x.defNameStarts.add(name.node.startIndex);
      x.byNode.set(def.node.id, x.add(def.node, name.node.text, def.name.slice("def.".length) as SymbolKind));
    }

    const extract = {
      typescript: extractJs,
      tsx: extractJs,
      javascript: extractJs,
      python: extractPython,
      go: extractGo,
      java: extractJava,
      csharp: extractCSharp,
      rust: extractRust,
    }[spec.id];
    extract(x, root);
    for (const d of x.drafts) if (x.exportedNames.has(d.name) && !d.private && d.kind !== "test") d.exported = true;

    // Order by position (outer before inner), then resolve parents.
    const drafts = x.drafts
      .map((d, i) => ({ d, i }))
      .sort((a, b) => a.d.start - b.d.start || b.d.end - a.d.end || a.i - b.i)
      .map((e) => e.d);
    const index = new Map(drafts.map((d, i) => [d, i]));
    const parentOf = new Map<Draft, Draft | null>();
    const stack: Draft[] = [];
    for (const d of drafts) {
      while (stack.length && stack[stack.length - 1]!.end <= d.start) stack.pop();
      let parent: Draft | null = null;
      if (d.parentMode === "explicit") parent = d.explicitParent ?? null;
      else if (d.parentMode === "auto") {
        for (let k = stack.length - 1; k >= 0; k--) {
          const c = stack[k]!;
          if (c.end >= d.end && (c.start < d.start || c.end > d.end)) {
            parent = c;
            break;
          }
        }
      }
      parentOf.set(d, parent);
      if (d.container) stack.push(d);
    }
    // Go methods and Rust impl members belong to their receiver type when it is declared in this file.
    const typeByName = new Map(drafts.filter((d) => ["struct", "type", "class", "enum", "interface", "trait"].includes(d.kind)).map((d) => [d.name, d]));
    for (const d of drafts) if (d.receiver && !parentOf.get(d)) parentOf.set(d, typeByName.get(d.receiver) ?? null);

    const qualified = new Map<Draft, string>();
    const qualify = (d: Draft, depth = 0): string => {
      const known = qualified.get(d);
      if (known !== undefined) return known;
      const parent = parentOf.get(d);
      const sep = d.kind === "test" && parent?.kind === "test" ? " > " : ".";
      const name = parent && depth < 16 ? `${qualify(parent, depth + 1)}${sep}${d.name}` : d.receiver ? `${d.receiver}.${d.name}` : d.name;
      qualified.set(d, name);
      return name;
    };

    // TS/JS/Python: members of exported classes are exported unless private; nested functions never are.
    if (spec.id !== "go" && spec.id !== "java" && spec.id !== "csharp" && spec.id !== "rust") {
      for (const d of drafts) {
        const parent = parentOf.get(d);
        if (!parent || (d.kind !== "method" && d.kind !== "function")) continue;
        d.exported = ["class", "interface", "model"].includes(parent.kind) && parent.exported && !d.private;
      }
    }

    const symbols: ParsedSymbol[] = drafts.map((d) => {
      const content = lines.slice(d.startLine - 1, d.endLine).join("\n").slice(0, MAX_SYMBOL_CHARS);
      const parent = parentOf.get(d);
      return {
        name: d.name,
        kind: d.kind,
        startLine: d.startLine,
        endLine: d.endLine,
        content,
        signature: signatureOf(content),
        qualifiedName: UNQUALIFIED_KINDS.has(d.kind) ? d.name : qualify(d),
        exported: d.exported && !UNEXPORTED_KINDS.has(d.kind),
        parent: parent ? index.get(parent)! : null,
      };
    });

    const containers = drafts.map((d, i) => ({ start: d.start, end: d.end, index: i })).filter((s) => drafts[s.index]!.container);

    const callCaptures = q.calls
      .captures(root)
      .filter((c) => c.name === "call" && !x.definingCallees.has(c.node.startIndex))
      .slice(0, MAX_CALLS);
    const callFrom = innermostContaining(containers, callCaptures.map((c) => c.node.startIndex));
    const calls = callCaptures.map((c, i) => ({ name: c.node.text, line: c.node.startPosition.row + 1, from: callFrom[i]! }));

    const imports = q.imports
      .captures(root)
      .filter((c) => c.name === "import")
      .map((c) => ({ target: cleanImport(spec.id, c.node.text), line: c.node.startPosition.row + 1 }))
      .filter((i) => i.target.length > 0)
      .slice(0, MAX_IMPORTS);

    const refFrom = innermostContaining(containers, x.references.map((r) => r.offset));
    const heritageKeys = new Set(x.heritage.map((h) => `${index.get(h.from)}:${h.name}`));
    const refSeen = new Set<string>();
    const references: NamedEdge[] = [];
    x.references.forEach((r, i) => {
      const from = refFrom[i]!;
      const key = `${from}:${r.name}`;
      if (references.length >= MAX_REFERENCES || refSeen.has(key) || heritageKeys.has(key)) return;
      if (from !== null && (symbols[from]!.name === r.name || (symbols[from]!.parent !== null && symbols[symbols[from]!.parent!]!.name === r.name))) return;
      refSeen.add(key);
      references.push({ name: r.name, line: r.line, from });
    });

    return {
      language: spec.id,
      symbols,
      calls,
      imports,
      exports: x.exports.slice(0, MAX_IMPORTS),
      references,
      heritage: x.heritage.map((h) => ({ kind: h.kind, name: h.name, line: h.line, from: index.get(h.from)! })),
      routeHandlers: x.routeHandlers.map((r) => ({ route: index.get(r.route)!, handler: r.handler, line: r.line })),
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}
