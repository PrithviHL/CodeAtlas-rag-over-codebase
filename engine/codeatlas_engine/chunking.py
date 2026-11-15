"""Deterministic syntax-boundary chunks with content-addressed embeddings."""

from __future__ import annotations
import ast
import hashlib
import re
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

LANGUAGES = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".rb": "ruby",
}
TEXT = set(LANGUAGES) | {
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".sql",
    ".css",
    ".html",
    ".sh",
}
DECLARATIONS = {
    "function_declaration",
    "function_definition",
    "method_definition",
    "method_declaration",
    "class_declaration",
    "class_definition",
    "function_item",
    "impl_item",
    "lexical_declaration",
    "export_statement",
}
VERSION = "ast-v1-2400"


@dataclass(frozen=True)
class Chunk:
    id: str
    repo: str
    path: str
    start_line: int
    end_line: int
    symbol: str
    body: str
    content_hash: str
    strategy: str

    @property
    def embedding_text(self):
        return f"{self.path}\n{self.symbol}\n{self.body}"

    def dict(self):
        return asdict(self)


def chunks(repo: str, path: str, source: str) -> list[Chunk]:
    lines = source.splitlines(keepends=True)
    if not lines:
        return []
    boundaries: list[tuple[int, int, str]] = []
    strategy = "text-window"
    language = LANGUAGES.get(Path(path).suffix)
    if language == "python":
        try:
            tree = ast.parse(source)
            for node in tree.body:
                if isinstance(
                    node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
                ):
                    start = (
                        min([node.lineno] + [d.lineno for d in node.decorator_list]) - 1
                    )
                    boundaries.append(
                        (start, node.end_lineno or node.lineno, node.name)
                    )
            strategy = "python-ast"
        except SyntaxError:
            strategy = "syntax-error-window"
    elif language:
        from tree_sitter_language_pack import get_parser

        root = get_parser(language).parse(source.encode()).root_node
        if root.has_error:
            strategy = "syntax-error-window"
        else:
            strategy = f"tree-sitter-{language}"
            for node in root.children:
                if node.type in DECLARATIONS:
                    name = node.child_by_field_name("name")
                    symbol = (
                        name.text.decode()
                        if name is not None
                        else lines[node.start_point[0]].strip()[:100]
                    )
                    end = node.end_point[0] + bool(node.end_point[1])
                    boundaries.append((node.start_point[0], end, symbol))
    spans, cursor = [], 0
    for start, end, symbol in sorted(boundaries):
        if start < cursor:
            continue
        if start > cursor:
            spans.append((cursor, start, "module"))
        spans.append((start, end, symbol))
        cursor = end
    if cursor < len(lines):
        spans.append((cursor, len(lines), "module"))
    result, occurrences = [], {}
    for start, end, symbol in spans:
        pos = start
        while pos < end:
            stop, length = pos, 0
            while (
                stop < end
                and stop - pos < 80
                and (length + len(lines[stop]) <= 2400 or stop == pos)
            ):
                length += len(lines[stop])
                stop += 1
            # Very long generated lines are bounded, not sent as unbounded prompts.
            body = "".join(lines[pos:stop])
            for offset in range(0, len(body), 2400):
                part = body[offset : offset + 2400]
                if not part.strip():
                    continue
                digest = hashlib.sha256(
                    f"{VERSION}\0{path}\0{symbol}\0{part}".encode()
                ).hexdigest()
                occurrence = occurrences.get(digest, 0)
                occurrences[digest] = occurrence + 1
                identity = str(
                    uuid.uuid5(uuid.NAMESPACE_URL, f"{repo}:{digest}:{occurrence}")
                )
                a = pos + body[:offset].count("\n") + 1
                b = a + part.rstrip("\n").count("\n")
                result.append(
                    Chunk(identity, repo, path, a, b, symbol, part, digest, strategy)
                )
            pos = stop
    return result


def terms(value: str) -> list[str]:
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    return re.findall(r"[a-z0-9]+", value.lower().replace("_", " "))
