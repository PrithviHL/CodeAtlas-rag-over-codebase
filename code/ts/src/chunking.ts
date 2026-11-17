import { createRequire } from "node:module";
import path from "node:path";
import type { Language as Grammar, Node, Tree } from "@vscode/tree-sitter-wasm";
import type { Chunk, SourceDefinition } from "./types.ts";

export const CHUNKER_VERSION = "tree-sitter-v2-full-definitions";
const require = createRequire(import.meta.url);
const { Parser, Language } = require("@vscode/tree-sitter-wasm") as typeof import("@vscode/tree-sitter-wasm");
const wasmDir = path.dirname(require.resolve("@vscode/tree-sitter-wasm"));
const languages: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".rb": "ruby",
  ".c": "cpp", ".h": "cpp", ".cpp": "cpp", ".sh": "bash", ".css": "css",
};
const declarations = new Set([
  "function_declaration", "generator_function_declaration", "function_definition", "method_declaration",
  "class_declaration", "class_definition", "class", "module", "method", "singleton_method",
  "interface_declaration", "type_alias_declaration", "enum_declaration", "struct_item", "enum_item",
  "impl_item", "trait_item", "function_item", "mod_item", "type_declaration", "const_declaration",
  "var_declaration", "lexical_declaration", "variable_declaration", "struct_specifier", "enum_specifier",
  "namespace_definition", "class_specifier", "rule_set",
]);
const wrappers = new Set(["export_statement", "decorated_definition"]);
let initialized: Promise<void> | undefined;
const grammars = new Map<string, Promise<Grammar>>();
async function grammar(name: string): Promise<Grammar> {
  initialized ??= Parser.init({ locateFile: (file: string) => path.join(wasmDir, file) });
  await initialized;
  let loaded = grammars.get(name);
  if (!loaded) {
    loaded = Language.load(path.join(wasmDir, `tree-sitter-${name}.wasm`));
    grammars.set(name, loaded);
  }
  return loaded;
}
function declaration(node: Node): Node | null {
  if (declarations.has(node.type)) return node;
  if (wrappers.has(node.type)) {
    for (const child of node.namedChildren) {
      const found = child && declaration(child);
      if (found) return found;
    }
  }
  return null;
}
function symbol(node: Node, fallback: string): string {
  if (node.type === "rule_set") return node.namedChildren[0]?.text ?? fallback;
  const name = node.childForFieldName("name");
  if (name) return name.text;
  for (const child of node.namedChildren) {
    const name = child?.childForFieldName("name") ?? child?.childForFieldName("declarator");
    if (name) return name.text;
  }
  return fallback;
}

const classNodes = new Set(["class_declaration", "class_definition", "class", "struct_item", "enum_item", "trait_item", "interface_declaration", "struct_specifier", "class_specifier"]);
const functionNodes = new Set(["function_declaration", "generator_function_declaration", "function_definition", "function_item", "method_declaration", "method_definition", "method", "singleton_method"]);
function definitionName(node: Node): string | undefined {
  const name = node.childForFieldName("name");
  if (name) return name.text;
  const declarator = node.childForFieldName("declarator");
  if (declarator) return definitionName(declarator) ?? (/identifier$/.test(declarator.type) ? declarator.text : undefined);
  return undefined;
}
function collectDefinitions(root: Node, file: string): SourceDefinition[] {
  const result: SourceDefinition[] = [];
  function visit(node: Node, scope: string[]): void {
    const callableVariable = node.type === "variable_declarator" && ["arrow_function", "function_expression", "generator_function"].includes(node.childForFieldName("value")?.type ?? "");
    const isClass = classNodes.has(node.type);
    const name = (isClass || functionNodes.has(node.type) || callableVariable) ? definitionName(node) : undefined;
    let nextScope = scope;
    if (name) {
      let boundary = node;
      if (callableVariable && node.parent && ["lexical_declaration", "variable_declaration"].includes(node.parent.type)) {
        // Include const/let only when the statement contains this one binding.
        if (node.parent.namedChildren.filter(c => c?.type === "variable_declarator").length === 1) boundary = node.parent;
      }
      while (boundary.parent && wrappers.has(boundary.parent.type)) boundary = boundary.parent;
      const qualifiedName = [...scope, name].join(".");
      result.push({ path: file, symbol: name, qualifiedName,
        kind: isClass ? "class" : /method/.test(node.type) ? "method" : "function",
        startLine: boundary.startPosition.row + 1,
        endLine: boundary.endPosition.row + (boundary.endPosition.column > 0 ? 1 : 0),
        startIndex: boundary.startIndex, endIndex: boundary.endIndex });
      nextScope = [...scope, name];
    }
    for (const child of node.namedChildren) if (child) visit(child, nextScope);
  }
  visit(root, []);
  return result;
}

// Parse source as data only. Each parser/tree is released; grammar WASMs are cached.
export async function indexSource(repo: string, file: string, source: string): Promise<{ chunks: Chunk[]; definitions: SourceDefinition[] }> {
  if (!source.trim()) return { chunks: [], definitions: [] };
  let definitions: SourceDefinition[] = [];
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const spans: { start: number; end: number; symbol: string }[] = [];
  const language = languages[path.extname(file)];
  let strategy = "text-window";
  if (language) {
    const loaded = await grammar(language);
    const parser = new Parser();
    let tree: Tree | null = null;
    try {
      parser.setLanguage(loaded);
      parser.setTimeoutMicros(100_000);
      tree = parser.parse(source);
      if (!tree || tree.rootNode.hasError) strategy = "syntax-error-window";
      else {
        strategy = `tree-sitter-${language}`;
        definitions = collectDefinitions(tree.rootNode, file);
        for (const node of tree.rootNode.namedChildren) {
          if (!node) continue;
          const found = declaration(node);
          if (!found) continue;
          const start = node.startPosition.row;
          const end = node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0);
          const previous = spans.at(-1);
          // Declarations on the same line share a citation, without duplicating source.
          if (previous && start < previous.end) {
            previous.end = Math.max(previous.end, end);
            previous.symbol += `, ${symbol(found, file)}`;
          } else spans.push({ start, end, symbol: symbol(found, file) });
        }
      }
    } finally {
      tree?.delete();
      parser.delete();
    }
  }
  const chunks: Chunk[] = [];
  function emit(start: number, end: number, name: string): void {
    let pos = start;
    while (pos < end) {
      let stop = pos, length = 0;
      while (stop < end && stop - pos < 60 && (length + lines[stop].length + 1 <= 2400 || stop === pos)) {
        length += lines[stop].length + 1; stop++;
      }
      const body = lines.slice(pos, stop).join("\n");
      // Generated single lines must also respect the character bound.
      for (let offset = 0; offset < body.length; offset += 2400) {
        const part = body.slice(offset, offset + 2400);
        if (!part.trim()) continue;
        const first = pos + body.slice(0, offset).split("\n").length;
        chunks.push({ repo, path: file, startLine: first, endLine: first + part.split("\n").length - 1,
          symbol: name, summary: file, body: part, strategy });
      }
      pos = stop < end && stop - pos > 12 ? stop - 12 : stop;
    }
  }
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) emit(cursor, span.start, file);
    emit(span.start, span.end, span.symbol);
    cursor = span.end;
  }
  if (cursor < lines.length) emit(cursor, lines.length, file);
  return { chunks, definitions };
}

export async function chunkSource(repo: string, file: string, source: string): Promise<Chunk[]> {
  return (await indexSource(repo, file, source)).chunks;
}
