import path from "node:path";
import type Parser from "web-tree-sitter";
import type { Relationship, SymbolNode } from "./indexer";

// Tree-sitter extraction of definitions, imports and calls with import/call resolution to
// repository files. Node types match the tree-sitter-wasms 0.1.13 grammar builds.
type Node = Parser.SyntaxNode;
type Import = { module: string; binding?: string; wildcard?: boolean; relative?: boolean; symbol?: string };
export type ExtractedEdge = Relationship & { symbol?: string; resolved?: boolean };

const definitions: Record<string, Record<string, string>> = {
  python: { function_definition: "function", class_definition: "class" },
  go: { function_declaration: "function", method_declaration: "method", type_spec: "type" },
  java: { class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "record", method_declaration: "method", constructor_declaration: "constructor" },
  kotlin: { class_declaration: "class", object_declaration: "object", function_declaration: "function" },
  rust: { function_item: "function", struct_item: "struct", enum_item: "enum", trait_item: "trait", type_item: "type", mod_item: "module", const_item: "const", static_item: "static" },
  ruby: { method: "method", singleton_method: "method", class: "class", module: "module" },
  c_sharp: { class_declaration: "class", interface_declaration: "interface", struct_declaration: "struct", enum_declaration: "enum", record_declaration: "record", method_declaration: "method", constructor_declaration: "constructor" },
  php: { function_definition: "function", method_declaration: "method", class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait", enum_declaration: "enum" },
  c: { function_definition: "function", struct_specifier: "struct", enum_specifier: "enum", type_definition: "type" },
  cpp: { function_definition: "function", struct_specifier: "struct", class_specifier: "class", enum_specifier: "enum" },
  swift: { function_declaration: "function", class_declaration: "class", protocol_declaration: "protocol" },
};
const callNodes: Record<string, string[]> = {
  python: ["call"], go: ["call_expression"], java: ["method_invocation", "object_creation_expression"], kotlin: ["call_expression"], rust: ["call_expression"], ruby: ["call"],
  c_sharp: ["invocation_expression", "object_creation_expression"], php: ["function_call_expression", "member_call_expression", "scoped_call_expression", "nullsafe_member_call_expression"],
  c: ["call_expression"], cpp: ["call_expression"], swift: ["call_expression"],
};
const importNodes: Record<string, string[]> = {
  python: ["import_statement", "import_from_statement"], go: ["import_spec"], java: ["import_declaration"], kotlin: ["import_header"], rust: ["use_declaration"], ruby: ["call"],
  c_sharp: ["using_directive"], php: ["namespace_use_clause"], c: ["preproc_include"], cpp: ["preproc_include"], swift: ["import_declaration"],
};
const terminalDeclarators = new Set(["identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name", "type_identifier"]);
const selfQualifiers = new Set(["self", "this", "$this", "static", "parent", "super", "Self"]);

function definitionName(node: Node, grammar: string): string | undefined {
  if ((grammar === "c" || grammar === "cpp") && /_specifier$/.test(node.type) && !node.childForFieldName("body")) return undefined;
  const named = node.childForFieldName("name");
  if (named) return named.type === "qualified_identifier" ? named.childForFieldName("name")?.text ?? named.text : named.text;
  if (grammar === "kotlin") return node.namedChildren.find((c) => c.type === "simple_identifier" || c.type === "type_identifier")?.text;
  if (grammar === "c" || grammar === "cpp") {
    let d = node.childForFieldName("declarator");
    for (let i = 0; d && !terminalDeclarators.has(d.type) && i < 8; i++) d = d.childForFieldName("declarator") ?? d.namedChildren.find((c) => terminalDeclarators.has(c.type) || /declarator$/.test(c.type)) ?? null;
    return d?.type === "qualified_identifier" ? d.childForFieldName("name")?.text : d?.text;
  }
  return undefined;
}
function isExported(node: Node, grammar: string, name: string) {
  const head = node.text.slice(0, 300).split(/[{(=]/)[0];
  switch (grammar) {
    case "python": return !name.startsWith("_");
    case "go": return /^[A-Z]/.test(name);
    case "rust": return node.namedChildren.some((c) => c.type === "visibility_modifier");
    case "c": case "cpp": return !/^\s*static\b/.test(head);
    case "ruby": return true;
    case "kotlin": case "swift": case "php": return !/\b(private|fileprivate|protected|internal)\b/.test(head);
    default: return /\bpublic\b/.test(head);
  }
}
function callee(node: Node, grammar: string): { name: string; qualifier?: string; path?: string } | undefined {
  let target: Node | null = null, qualifier: string | undefined;
  if (node.type === "method_invocation" || node.type === "member_call_expression" || node.type === "nullsafe_member_call_expression") { target = node.childForFieldName("name"); qualifier = node.childForFieldName("object")?.text; }
  else if (node.type === "scoped_call_expression") { target = node.childForFieldName("name"); qualifier = node.childForFieldName("scope")?.text; }
  else if (node.type === "object_creation_expression") target = node.childForFieldName("type");
  else if (node.type === "call" && grammar === "ruby") { target = node.childForFieldName("method"); qualifier = node.childForFieldName("receiver")?.text; }
  else target = node.childForFieldName("function") ?? node.namedChildren[0] ?? null;
  if (!target) return undefined;
  const parts = target.text.slice(0, 300).replace(/<[^<>]*>/g, "").split(/\?\.|\.|::|->|\\/).map((s) => s.trim()).filter(Boolean);
  const name = parts.at(-1)?.replace(/[!?]$/, "");
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  const q = qualifier ?? (parts.length > 1 ? parts.slice(0, -1).join("::") : undefined);
  return { name, qualifier: q?.split(/\?\.|\.|::|->|\\/).filter(Boolean).at(-1), path: q };
}
function importsOf(root: Node, grammar: string): Import[] {
  const out: Import[] = [];
  const last = (s: string, sep: RegExp) => s.split(sep).filter(Boolean).at(-1);
  for (const node of root.descendantsOfType(importNodes[grammar] ?? [])) {
    switch (grammar) {
      case "python": {
        if (node.type === "import_statement") {
          for (const c of node.namedChildren) {
            if (c.type === "dotted_name") out.push({ module: c.text, binding: last(c.text, /\./) });
            else if (c.type === "aliased_import") out.push({ module: c.childForFieldName("name")?.text ?? "", binding: c.childForFieldName("alias")?.text });
          }
        } else {
          const moduleNode = node.childForFieldName("module_name"), from = moduleNode?.text ?? "";
          for (const c of node.namedChildren) {
            if (moduleNode && c.equals(moduleNode)) continue;
            if (c.type === "dotted_name") out.push({ module: from, symbol: c.text, binding: c.text, relative: from.startsWith(".") });
            else if (c.type === "aliased_import") { const name = c.childForFieldName("name")?.text ?? ""; out.push({ module: from, symbol: name, binding: c.childForFieldName("alias")?.text ?? name, relative: from.startsWith(".") }); }
            else if (c.type === "wildcard_import") out.push({ module: from, wildcard: true, relative: from.startsWith(".") });
          }
        }
        break;
      }
      case "go": {
        const spec = node.childForFieldName("path")?.text.replace(/^["`]|["`]$/g, "") ?? "";
        out.push({ module: spec, binding: node.childForFieldName("name")?.text ?? last(spec, /\//) });
        break;
      }
      case "java": {
        const id = node.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text ?? "";
        out.push({ module: id, binding: last(id, /\./), wildcard: node.namedChildren.some((c) => c.type === "asterisk") });
        break;
      }
      case "kotlin": {
        const id = node.namedChildren.find((c) => c.type === "identifier")?.text.replace(/\s+/g, "") ?? "";
        const alias = node.namedChildren.find((c) => c.type === "import_alias")?.namedChildren[0]?.text;
        out.push({ module: id, binding: alias ?? last(id, /\./), wildcard: /\.\*$/.test(node.text) });
        break;
      }
      case "rust": {
        const flatten = (n: Node | null, prefix: string): void => {
          if (!n) return;
          if (n.type === "scoped_use_list") { const p = n.childForFieldName("path")?.text; flatten(n.childForFieldName("list"), (p ? prefix + p : prefix.replace(/::$/, "")) + "::"); }
          else if (n.type === "use_list") for (const c of n.namedChildren) flatten(c, prefix);
          else if (n.type === "use_as_clause") { const p = prefix + (n.childForFieldName("path")?.text ?? ""); out.push({ module: p, binding: n.childForFieldName("alias")?.text }); }
          else if (n.type === "use_wildcard") out.push({ module: prefix + n.text.replace(/::\*$/, ""), wildcard: true });
          else if (n.type === "scoped_identifier" || n.type === "identifier" || n.type === "crate" || n.type === "self" || n.type === "super") out.push({ module: prefix + n.text, binding: last(n.text, /::/) });
        };
        flatten(node.childForFieldName("argument"), "");
        break;
      }
      case "ruby": {
        const method = node.childForFieldName("method")?.text;
        const arg = node.childForFieldName("arguments")?.namedChildren[0];
        if (method && /^(require|require_relative|load)$/.test(method) && arg?.type === "string") out.push({ module: arg.text.replace(/^['"]|['"]$/g, ""), relative: method === "require_relative" });
        break;
      }
      case "php": {
        const name = node.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name")?.text ?? "";
        const alias = node.namedChildren.find((c) => c.type === "namespace_aliasing_clause")?.namedChildren[0]?.text;
        out.push({ module: name.replace(/^\\/, ""), binding: alias ?? last(name, /\\/) });
        break;
      }
      case "c": case "cpp": {
        const p = node.childForFieldName("path");
        if (p?.type === "string_literal") out.push({ module: p.text.replace(/^"|"$/g, ""), relative: true });
        break;
      }
      case "c_sharp": case "swift":
        out.push({ module: node.namedChildren.find((c) => /identifier|qualified_name/.test(c.type))?.text ?? "" });
        break;
    }
  }
  return out.filter((i) => i.module || i.relative);
}

// Path lookup structure over every known repository path (cached per path list).
type PathIndex = { paths: Set<string>; dirs: Set<string>; byBase: Map<string, string[]> };
const indexCache = new WeakMap<readonly string[], PathIndex>();
export function pathIndex(paths: readonly string[]): PathIndex {
  const cached = indexCache.get(paths);
  if (cached) return cached;
  const index: PathIndex = { paths: new Set(paths), dirs: new Set(), byBase: new Map() };
  for (const p of paths) {
    const base = p.split("/").at(-1)!;
    index.byBase.set(base, [...(index.byBase.get(base) ?? []), p]);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) index.dirs.add(parts.slice(0, i).join("/") + "/");
  }
  indexCache.set(paths, index);
  return index;
}
const shared = (a: string, b: string) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return n; };
const pick = (candidates: string[], from: string) => candidates.sort((a, b) => shared(b, from) - shared(a, from) || a.length - b.length)[0];
function bySuffix(index: PathIndex, suffix: string, from: string) {
  const base = suffix.split("/").at(-1)!;
  const candidates = (index.byBase.get(base) ?? []).filter((p) => p === suffix || p.endsWith("/" + suffix));
  return candidates.length ? pick(candidates, from) : undefined;
}
function dirBySuffix(index: PathIndex, suffix: string, from: string) {
  const want = suffix.replace(/\/?$/, "/");
  const candidates = [...index.dirs].filter((d) => d === want || d.endsWith("/" + want));
  return candidates.length ? pick(candidates, from) : undefined;
}
const normalize = (p: string) => { const n = path.posix.normalize(p); return n.startsWith("../") || n === ".." ? undefined : n.replace(/^\.\//, ""); };
const dirOf = (p: string) => path.posix.dirname(p).replace(/^\.$/, "");
const first = (index: PathIndex, candidates: (string | undefined)[]) => candidates.find((c): c is string => !!c && index.paths.has(c));

function resolveImport(file: string, imp: Import, grammar: string, index: PathIndex): string | undefined {
  const here = dirOf(file);
  switch (grammar) {
    case "python": {
      const dots = imp.module.match(/^\.+/)?.[0].length ?? 0, rest = imp.module.slice(dots), segs = rest ? rest.split(".") : [];
      const roots = dots ? [normalize([here, ...Array(dots - 1).fill("..")].filter(Boolean).join("/") || ".")] : ["", "src", "lib", "app"];
      const candidates = (extra: string[]) => roots.flatMap((root) => root === undefined ? [] : [normalize([root, ...segs, ...extra].filter(Boolean).join("/") + ".py"), normalize([root, ...segs, ...extra, "__init__.py"].filter(Boolean).join("/"))]);
      return (imp.symbol ? first(index, candidates([imp.symbol])) : undefined) ?? first(index, candidates([])) ?? (segs.length && !dots ? bySuffix(index, segs.join("/") + ".py", file) : undefined);
    }
    case "go": {
      const segs = imp.module.split("/");
      for (let k = Math.min(segs.length, 6); k >= 1; k--) { const dir = dirBySuffix(index, segs.slice(-k).join("/"), file); if (dir && [...index.paths].some((p) => p.startsWith(dir) && p.endsWith(".go") && !p.slice(dir.length).includes("/"))) return dir; }
      return undefined;
    }
    case "java": case "kotlin": {
      const segs = imp.module.split(".");
      if (imp.wildcard) return dirBySuffix(index, segs.join("/"), file);
      for (const ext of [".java", ".kt", ".kts"]) { const hit = bySuffix(index, segs.join("/") + ext, file); if (hit) return hit; }
      if (segs.length > 1) for (const ext of [".kt", ".java"]) { const hit = bySuffix(index, segs.slice(0, -1).join("/") + ext, file); if (hit) return hit; }
      return segs.length > 1 ? dirBySuffix(index, segs.slice(0, -1).join("/"), file) : undefined;
    }
    case "rust": {
      const segs = imp.module.split("::").filter(Boolean);
      const moduleDir = (f: string) => { const name = path.posix.basename(f); return /^(mod|lib|main)\.rs$/.test(name) ? dirOf(f) : [dirOf(f), name.replace(/\.rs$/, "")].filter(Boolean).join("/"); };
      const crateRoot = () => { for (let d = here; ; d = dirOf(d)) { if (index.paths.has([d, "lib.rs"].filter(Boolean).join("/")) || index.paths.has([d, "main.rs"].filter(Boolean).join("/"))) return d; if (!d) return index.dirs.has("src/") ? "src" : ""; } };
      let root: string | undefined, rest = segs;
      if (segs[0] === "crate") { root = crateRoot(); rest = segs.slice(1); }
      else if (segs[0] === "super") { root = dirOf(moduleDir(file)); rest = segs.slice(1); while (rest[0] === "super") { root = dirOf(root); rest = rest.slice(1); } }
      else if (segs[0] === "self") { root = moduleDir(file); rest = segs.slice(1); }
      for (const base of root !== undefined ? [root] : [moduleDir(file), crateRoot()])
        for (let k = rest.length; k >= 1; k--) {
          const stem = [base, ...rest.slice(0, k)].filter(Boolean).join("/");
          const hit = first(index, [stem + ".rs", stem + "/mod.rs"]);
          if (hit) return hit;
        }
      return undefined;
    }
    case "ruby": {
      const withExt = imp.module.endsWith(".rb") ? imp.module : imp.module + ".rb";
      return imp.relative ? first(index, [normalize([here, withExt].filter(Boolean).join("/"))]) : first(index, ["lib/" + withExt, withExt]) ?? bySuffix(index, withExt, file);
    }
    case "php": {
      const segs = imp.module.split("\\").filter(Boolean);
      if (!segs.length) return undefined;
      const rest = segs.slice(1).join("/");
      return first(index, [segs.join("/") + ".php", [segs[0][0].toLowerCase() + segs[0].slice(1), ...segs.slice(1)].join("/") + ".php", rest && "src/" + rest + ".php", rest && "app/" + rest + ".php"]) ?? (segs.length > 1 ? bySuffix(index, segs.slice(-2).join("/") + ".php", file) : undefined);
    }
    case "c": case "cpp":
      return first(index, [normalize([here, imp.module].filter(Boolean).join("/")), "include/" + imp.module]) ?? bySuffix(index, imp.module, file);
    default:
      return undefined;
  }
}

export function extractTreeSitter(root: Node, grammar: string, file: string, knownPaths: readonly string[]): { symbols: SymbolNode[]; relationships: ExtractedEdge[] } {
  const symbols: SymbolNode[] = [], edges = new Map<string, ExtractedEdge>();
  const add = (edge: ExtractedEdge) => { if (edge.to && edge.to !== edge.from) edges.set([edge.from, edge.to, edge.kind, edge.symbol ?? ""].join("\0"), edge); };
  const kinds = definitions[grammar] ?? {};
  for (const node of root.descendantsOfType(Object.keys(kinds))) {
    const name = definitionName(node, grammar);
    if (name && /^[A-Za-z_$~][\w$~]*$/.test(name)) symbols.push({ name, kind: kinds[node.type], path: file, line: node.startPosition.row + 1, exported: isExported(node, grammar, name) });
  }
  const index = pathIndex(knownPaths);
  const bindings = new Map<string, string>();
  for (const imp of importsOf(root, grammar)) {
    const target = resolveImport(file, imp, grammar, index);
    add({ from: file, to: target ?? imp.module, kind: "imports", symbol: imp.binding, resolved: !!target });
    if (target && imp.binding) bindings.set(imp.binding, target);
  }
  const defined = new Set(symbols.map((s) => s.name));
  for (const node of root.descendantsOfType(callNodes[grammar] ?? [])) {
    const call = callee(node, grammar);
    if (!call) continue;
    let target: string | undefined;
    if (call.qualifier && selfQualifiers.has(call.qualifier)) target = defined.has(call.name) ? file : undefined;
    else if (call.qualifier) target = bindings.get(call.qualifier) ?? (grammar === "rust" && call.path && /^(crate|super|self)(::|$)/.test(call.path) ? resolveImport(file, { module: call.path }, grammar, index) : undefined);
    else target = bindings.get(call.name) ?? (defined.has(call.name) ? file : undefined);
    if (target) add({ from: file, to: target, kind: "calls", symbol: call.name, resolved: true });
    else add({ from: file, to: (call.qualifier ? call.qualifier + "." : "") + call.name, kind: "calls", resolved: false });
    if (edges.size > 1500) break;
  }
  return { symbols, relationships: [...edges.values()] };
}
