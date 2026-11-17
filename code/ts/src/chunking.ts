import { createRequire } from "node:module";
import path from "node:path";
import type { Language as Grammar, Node, Tree } from "@vscode/tree-sitter-wasm";
import type { Chunk } from "./types.ts";

export const CHUNKER_VERSION = "tree-sitter-v1";
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

// Parse source as data only. Each parser/tree is released; grammar WASMs are cached.
export async function chunkSource(repo: string, file: string, source: string): Promise<Chunk[]> {
  if (!source.trim()) return [];
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
  return chunks;
}
