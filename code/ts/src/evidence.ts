import path from "node:path";
import type { RankedChunk, SourceDefinition } from "./types.ts";

export type SourceSnapshot = { sources?: Record<string, string>; definitions?: SourceDefinition[] };
export type Evidence = {
  path: string; startLine: number; endLine: number; body: string; score: number;
  symbol?: string; kind?: SourceDefinition["kind"]; complete?: boolean;
};
const prose = new Set(["a", "an", "and", "as", "at", "be", "by", "class", "code", "do", "does", "for", "from", "function", "give", "how", "in", "is", "it", "me", "method", "of", "or", "please", "return", "show", "source", "that", "the", "this", "to", "what", "with"]);
function exactDefinitions(snapshot: SourceSnapshot, question: string): SourceDefinition[] {
  const definitions = snapshot.definitions ?? [];
  const tokens = new Set((question.match(/[\p{L}_$][\p{L}\p{N}_$]*(?:(?:\.|::|#)[\p{L}_$][\p{L}\p{N}_$]*)*/gu) ?? []).map(t => t.replace(/::|#/g, ".")));
  const quoted = new Set([...question.matchAll(/[`'"]([^`'"]+)[`'"]/g)].map(m => m[1].replace(/\(\)$/, "")));
  let matches = definitions.filter(d => (tokens.has(d.qualifiedName) || tokens.has(d.symbol)) && (!prose.has(d.symbol) || (d.qualifiedName !== d.symbol && tokens.has(d.qualifiedName)) || quoted.has(d.symbol) || question.includes(`${d.symbol}(`)));
  // A supplied file name/path narrows duplicate symbols, rather than choosing arbitrarily.
  const paths = [...new Set(definitions.map(d => d.path))];
  const mentionedPaths: string[] = question.match(/(?:[\w.-]+\/)+[\w.-]+\.[\w]+/g) ?? [];
  const fullPaths = paths.filter(file => mentionedPaths.includes(file));
  const hints = mentionedPaths.length ? fullPaths : paths.filter(file => tokens.has(path.basename(file)));
  if (mentionedPaths.length || hints.length) matches = matches.filter(d => hints.includes(d.path));
  const scoped = matches.filter(d => d.qualifiedName !== d.symbol && (tokens.has(d.qualifiedName) || d.qualifiedName.split(".").slice(0, -1).some(s => tokens.has(s))));
  if (scoped.length) {
    const scopedNames = new Set(scoped.map(d => d.symbol));
    matches = matches.filter(d => !scopedNames.has(d.symbol) || scoped.includes(d));
    // In "show authorize in Auth", Auth is a qualifier, not a second requested body.
    matches = matches.filter(d => !scoped.some(child => child.path === d.path && child.qualifiedName.startsWith(`${d.qualifiedName}.`)));
  }
  return matches.sort((a, b) => a.path.localeCompare(b.path) || a.startIndex - b.startIndex);
}
function fullDefinition(snapshot: SourceSnapshot, definition: SourceDefinition, score: number): Evidence | undefined {
  const source = snapshot.sources?.[definition.path];
  if (source === undefined) return undefined;
  return { path: definition.path, startLine: definition.startLine, endLine: definition.endLine,
    body: source.slice(definition.startIndex, definition.endIndex), symbol: definition.qualifiedName,
    kind: definition.kind, complete: true, score };
}
export function sourceEvidence(snapshot: SourceSnapshot, question: string, ranked: RankedChunk[]): { exact: boolean; evidence: Evidence[] } {
  const exact = exactDefinitions(snapshot, question).flatMap(d => fullDefinition(snapshot, d, 1) ?? []);
  if (exact.length) return { exact: true, evidence: exact };
  // A failed explicit lookup must not substitute a similarly named declaration.
  const identifier = "[\\p{L}_$][\\p{L}\\p{N}_$]*(?:(?:\\.|::|#)[\\p{L}_$][\\p{L}\\p{N}_$]*)*";
  const named = question.match(new RegExp(`(?:class|function|method)\\s+(?:named\\s+)?[\x60'"]?(${identifier})`, "u"))?.[1];
  const calls = [...question.matchAll(new RegExp(`(${identifier})\\s*\\(`, "gu"))].map(m => m[1]);
  const qualified = [...question.matchAll(new RegExp(identifier, "gu"))].map(m => m[0]).filter(t => /[.#]|::/.test(t) && !/\.(?:tsx?|jsx?|py|go|rs|java|rb|cpp|c|h|sh|css|md|json)$/.test(t));
  if ((named && !prose.has(named)) || calls.length || qualified.length) return { exact: false, evidence: [] };
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const { chunk, score } of ranked) {
    const enclosing = (snapshot.definitions ?? []).filter(d => d.path === chunk.path && d.startLine <= chunk.startLine && d.endLine >= chunk.endLine)
      .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
    const full = enclosing && fullDefinition(snapshot, enclosing, score);
    const item: Evidence = full || { path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, body: chunk.body, score, complete: false };
    const key = full ? `${enclosing.path}:${enclosing.startIndex}:${enclosing.endIndex}` : `${chunk.path}:${chunk.startLine}:${chunk.endLine}:${chunk.body}`;
    if (seen.has(key)) continue;
    if (!full && evidence.some(p => p.path === item.path && p.startLine <= item.endLine && item.startLine <= p.endLine)) continue;
    seen.add(key); evidence.push(item);
  }
  return { exact: false, evidence };
}

// The explanation gets a bounded preview; display evidence retains the complete code.
export function modelExcerpts(citations: Evidence[]): string {
  return citations.slice(0, 4).map((c, i) => {
    const body = c.body.slice(0, 2400);
    const end = c.startLine + body.split("\n").length - 1;
    return `[${i + 1}] ${c.path}, lines ${c.startLine}-${end}${body.length < c.body.length ? " (partial preview; full code is in source evidence)" : ""}\n${body}`;
  }).join("\n\n");
}
