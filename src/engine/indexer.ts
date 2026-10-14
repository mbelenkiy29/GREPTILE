import { redact } from "../redact";
export { redact } from "../redact";
import ts from "typescript";
import ignore from "ignore";
import path from "node:path";
import type { SourceFile } from "./types";
import { extractTreeSitter } from "./graph-extract";
import { grammarFor, parserFor } from "./treesitter";

export type SymbolNode = {
  name: string;
  kind: string;
  path: string;
  line: number;
  exported: boolean;
};
export type Relationship = {
  from: string;
  to: string;
  kind:
    | "imports"
    | "exports"
    | "calls"
    | "extends"
    | "implements"
    | "references"
    | "tested-by"
    | "depends-on"
    | "route-to-handler"
    | "schema-to-consumer";
  // Resolved edges point at repository paths (or "dir/" packages); symbol is the called or
  // imported name. Unresolved call edges keep the raw callee text with resolved=false.
  symbol?: string;
  resolved?: boolean;
};
export type CodeIndex = {
  files: SourceFile[];
  symbols: SymbolNode[];
  relationships: Relationship[];
  moduleReferences?: {path:string;specifier:string;resolvedPath:string}[];
};
export function resolveModuleReference(filePath:string,spec:string,paths:ReadonlySet<string>):string {
  if (!spec.startsWith(".")) return spec;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), spec));
  // Infer a TypeScript source only when the explicit emitted path is absent.
  const sourceExtensions = base.endsWith(".mjs") ? [".mts"] : base.endsWith(".cjs") ? [".cts"] : base.endsWith(".js") ? [".ts", ".tsx"] : base.endsWith(".jsx") ? [".tsx"] : [];
  const candidates = [base, ...sourceExtensions.map(ext => base.replace(/\.[^.]+$/, ext))];
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  if (!path.posix.extname(base)) candidates.push(...extensions.map(ext => base + ext));
  candidates.push(...extensions.map(ext => base + "/index" + ext));
  return candidates.find(candidate => paths.has(candidate)) ?? base;
}
export function moduleReferencesCurrent(filePath:string,references:readonly {specifier:string;resolvedPath:string}[]|undefined,paths:ReadonlySet<string>):boolean {
  return references !== undefined && references.every(r=>resolveModuleReference(filePath,r.specifier,paths)===r.resolvedPath);
}
const excluded =
  /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.next|__pycache__|target)(\/|$)|(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519)$|\.(lock|png|jpg|jpeg|gif|ico|woff2?|zip|gz|pdf|pem|key|p12|sqlite|db|map|min\.js)$/i;
export function exclusionReason(file: SourceFile, gitignore = ""): string | undefined {
  if ((file.size ?? Buffer.byteLength(file.content,"utf8")) > 200_000) return "Exceeds 200 KB source limit";
  if (file.content.includes("\0")) return "Binary content";
  if (excluded.test(file.path)) return "Generated, dependency, secret, or non-source file";
  if (ignore().add(gitignore).ignores(file.path)) return "Excluded by .gitignore";
}
export function eligibleFile(file: SourceFile, gitignore = ""): boolean {
  return exclusionReason(file, gitignore) === undefined;
}
export function indexRepository(
  input: SourceFile[],
  knownPaths: string[] = [],
): CodeIndex {
  const gitignore = input.find((f) => f.path === ".gitignore")?.content ?? "";
  const files = input
    .filter((f) => eligibleFile(f, gitignore))
    .map((f) => ({ ...f, content: redact(f.content) }));
  const symbols: SymbolNode[] = [],
    relationships: Relationship[] = [];
  const paths = new Set([...knownPaths, ...files.map((f) => f.path)]);
  // Reuse the caller's path list (cached path index) when it already covers these files.
  const pathList: readonly string[] = files.every((f) => knownPaths.includes(f.path)) && knownPaths.length ? knownPaths : [...paths];
  const moduleReferences:NonNullable<CodeIndex["moduleReferences"]>=[];
  const resolveModule = (filePath: string, spec: string) => {
    const resolvedPath=resolveModuleReference(filePath,spec,paths);
    if(spec.startsWith("."))moduleReferences.push({path:filePath,specifier:spec,resolvedPath});
    return resolvedPath;
  };
  for (const file of files) {
    if (/\.[cm]?[jt]sx?$/.test(file.path)) {
      const tree = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
      );
      // Import bindings (local name → resolved module) let calls resolve to repository files.
      const bindings = new Map<string, string>(), defined = new Set<string>();
      for (const statement of tree.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
          const target = resolveModuleReference(file.path, statement.moduleSpecifier.text, paths);
          if (!paths.has(target)) continue;
          const clause = statement.importClause;
          if (clause.name) bindings.set(clause.name.text, target);
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.set(clause.namedBindings.name.text, target);
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) bindings.set(element.name.text, target);
        }
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) defined.add(statement.name.text);
        if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) defined.add(d.name.text);
      }
      const resolveCall = (expression: ts.Expression): { to: string; symbol: string } | undefined => {
        if (ts.isIdentifier(expression)) { const to = bindings.get(expression.text) ?? (defined.has(expression.text) ? file.path : undefined); return to ? { to, symbol: expression.text } : undefined; }
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && bindings.has(expression.expression.text)) return { to: bindings.get(expression.expression.text)!, symbol: expression.name.text };
        return undefined;
      };
      const visit = (node: ts.Node) => {
        const named =
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isVariableDeclaration(node);
        if (named && node.name)
          symbols.push({
            name: node.name.getText(tree),
            kind: ts.SyntaxKind[node.kind],
            path: file.path,
            line:
              tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
            exported:
              !!ts.getCombinedModifierFlags(node as ts.Declaration) &&
              !!(
                ts.getCombinedModifierFlags(node as ts.Declaration) &
                ts.ModifierFlags.Export
              ),
          });
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const spec = node.moduleSpecifier.text;
          const to = resolveModule(file.path, spec);
          relationships.push({ from: file.path, to, kind: "imports" });
          if (/schema|models?\//i.test(to))
            relationships.push({
              from: to,
              to: file.path,
              kind: "schema-to-consumer",
            });
        }
        if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          relationships.push({
            from: file.path,
            to: resolveModule(file.path, node.moduleSpecifier.text),
            kind: "exports",
          });
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression))
          relationships.push({from:file.path,to:resolveModule(file.path,node.moduleReference.expression.text),kind:"imports"});
        if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1)))
          relationships.push({from:file.path,to:resolveModule(file.path,node.arguments[0].text),kind:"imports"});
        if (
          ts.isFunctionDeclaration(node) &&
          node.name &&
          /(?:^|\/)route\.[jt]s$/.test(file.path)
        )
          relationships.push({
            from: file.path,
            to: node.name.text,
            kind: "route-to-handler",
          });
        if (ts.isCallExpression(node)) {
          const resolved = resolveCall(node.expression);
          if (resolved && resolved.to !== file.path) relationships.push({ from: file.path, to: resolved.to, kind: "calls", symbol: resolved.symbol, resolved: true });
          else if (!resolved)
            relationships.push({
              from: file.path,
              to: node.expression.getText(tree),
              kind: "calls",
              resolved: false,
            });
        }
        if (ts.isHeritageClause(node))
          for (const item of node.types)
            relationships.push({
              from: file.path,
              to: item.expression.getText(tree),
              kind:
                node.token === ts.SyntaxKind.ExtendsKeyword
                  ? "extends"
                  : "implements",
            });
        ts.forEachChild(node, visit);
      };
      visit(tree);
    } else if (parserFor(file.path)) {
      const tree = parserFor(file.path)!.parse(file.content);
      try {
        const extracted = extractTreeSitter(tree.rootNode, grammarFor(file.path)!, file.path, pathList);
        symbols.push(...extracted.symbols);
        relationships.push(...extracted.relationships);
      } finally {
        tree.delete();
      }
    } else {
      for (const [i, line] of file.content.split("\n").entries()) {
        const match =
          /^\s*(?:export\s+)?(?:async\s+)?(def|class|fn|func|function|struct|interface|type)\s+([A-Za-z_]\w*)/.exec(
            line,
          );
        if (match)
          symbols.push({
            name: match[2],
            kind: match[1],
            path: file.path,
            line: i + 1,
            exported: false,
          });
        const imported =
          /^\s*(?:from\s+(\S+)\s+import|import\s+(\S+)|require\s*\(['"]([^'"]+))/.exec(
            line,
          );
        if (imported)
          relationships.push({
            from: file.path,
            to: imported[1] ?? imported[2] ?? imported[3],
            kind: "imports",
          });
      }
    }
    if (file.path.endsWith("package.json")) {
      try {
        const manifest = JSON.parse(file.content);
        for (const field of [
          "dependencies",
          "devDependencies",
          "peerDependencies",
        ])
          if (manifest[field] && typeof manifest[field] === "object")
            for (const dependency of Object.keys(manifest[field]))
              relationships.push({
                from: file.path,
                to: dependency,
                kind: "depends-on",
              });
      } catch {
        /* Malformed manifests remain indexed source for reviewers to assess. */
      }
    }
    if (/(?:test|spec)\.[^.]+$/.test(file.path))
      for (const rel of relationships.filter(
        (r) => r.from === file.path && r.kind === "imports",
      ))
        relationships.push({ from: rel.to, to: file.path, kind: "tested-by" });
  }
  return { files, symbols, relationships, moduleReferences };
}
