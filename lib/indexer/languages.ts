/** tree-sitter grammars and tag queries for the languages the indexer understands (R1.3). */

export type LanguageId = "typescript" | "tsx" | "javascript" | "python" | "go" | "java" | "rust" | "csharp";

export interface LanguageSpec {
  id: LanguageId;
  wasm: string;
  extensions: string[];
  /** Captures `@name` inside a `@def.<kind>` node. */
  definitions: string;
  /** Captures `@call` on the callee identifier. */
  calls: string;
  /** Captures `@import` on the imported module/path text. */
  imports: string;
}

const jsCalls = `
(call_expression function: (identifier) @call)
(call_expression function: (member_expression property: (property_identifier) @call))
(new_expression constructor: (identifier) @call)
`;

const jsImports = `
(import_statement source: (string (string_fragment) @import))
(export_statement source: (string (string_fragment) @import))
(call_expression function: (identifier) @_fn arguments: (arguments (string (string_fragment) @import)) (#eq? @_fn "require"))
`;

const jsDefinitions = (classNameNode: string) => `
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(class_declaration name: (${classNameNode}) @name) @def.class
(method_definition name: (property_identifier) @name) @def.method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function
`;

const tsDefinitions = `${jsDefinitions("type_identifier")}
(abstract_class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(type_alias_declaration name: (type_identifier) @name) @def.type
(enum_declaration name: (identifier) @name) @def.enum
`;

export const LANGUAGES: LanguageSpec[] = [
  { id: "typescript", wasm: "tree-sitter-typescript.wasm", extensions: [".ts", ".mts", ".cts"], definitions: tsDefinitions, calls: jsCalls, imports: jsImports },
  { id: "tsx", wasm: "tree-sitter-tsx.wasm", extensions: [".tsx"], definitions: tsDefinitions, calls: jsCalls, imports: jsImports },
  {
    id: "javascript",
    wasm: "tree-sitter-javascript.wasm",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    definitions: jsDefinitions("identifier"),
    calls: jsCalls,
    imports: jsImports,
  },
  {
    id: "python",
    wasm: "tree-sitter-python.wasm",
    extensions: [".py"],
    definitions: `
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
`,
    calls: `
(call function: (identifier) @call)
(call function: (attribute attribute: (identifier) @call))
`,
    imports: `
(import_statement name: (dotted_name) @import)
(import_statement name: (aliased_import name: (dotted_name) @import))
(import_from_statement module_name: (dotted_name) @import)
(import_from_statement module_name: (relative_import) @import)
`,
  },
  {
    id: "go",
    wasm: "tree-sitter-go.wasm",
    extensions: [".go"],
    definitions: `
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(type_declaration (type_spec name: (type_identifier) @name)) @def.type
`,
    calls: `
(call_expression function: (identifier) @call)
(call_expression function: (selector_expression field: (field_identifier) @call))
`,
    imports: `(import_spec path: (interpreted_string_literal) @import)`,
  },
  {
    id: "java",
    wasm: "tree-sitter-java.wasm",
    extensions: [".java"],
    definitions: `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
`,
    calls: `
(method_invocation name: (identifier) @call)
(object_creation_expression type: (type_identifier) @call)
`,
    imports: `(import_declaration (scoped_identifier) @import)`,
  },
  {
    id: "rust",
    wasm: "tree-sitter-rust.wasm",
    extensions: [".rs"],
    definitions: `
(function_item name: (identifier) @name) @def.function
(function_signature_item name: (identifier) @name) @def.function
(struct_item name: (type_identifier) @name) @def.struct
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.trait
`,
    calls: `
(call_expression function: (identifier) @call)
(call_expression function: (field_expression field: (field_identifier) @call))
(call_expression function: (scoped_identifier name: (identifier) @call))
`,
    imports: `
(use_declaration argument: (_) @import)
(mod_item name: (identifier) @import)
`,
  },
  {
    id: "csharp",
    wasm: "tree-sitter-c-sharp.wasm",
    extensions: [".cs"],
    definitions: `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(struct_declaration name: (identifier) @name) @def.struct
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
`,
    calls: `
(invocation_expression function: (identifier) @call)
(invocation_expression function: (member_access_expression name: (identifier) @call))
(object_creation_expression type: (identifier) @call)
`,
    imports: `
(using_directive (qualified_name) @import)
(using_directive (identifier) @import)
`,
  },
];

const byExtension = new Map(LANGUAGES.flatMap((l) => l.extensions.map((e) => [e, l] as const)));

export function languageForPath(path: string): LanguageSpec | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || path.endsWith(".d.ts")) return undefined;
  return byExtension.get(path.slice(dot).toLowerCase());
}
