"""Independent stdlib-AST source spans; input is a JSON source snapshot on stdin."""
import ast
import json
import sys

sources = json.load(sys.stdin)
references = []
errors = []
for file, source in sources.items():
    if not file.endswith('.py'):
        continue
    try:
        root = ast.parse(source)
    except SyntaxError:
        errors.append(file)
        continue
    lines = source.splitlines(keepends=True)

    def offset(row, byte_column):
        return sum(len(line) for line in lines[:row - 1]) + len(lines[row - 1].encode('utf-8')[:byte_column].decode('utf-8'))

    def visit(node, scope):
        next_scope = scope
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            start_line = min([node.lineno] + [d.lineno for d in node.decorator_list])
            start = offset(start_line, node.col_offset)
            end = offset(node.end_lineno, node.end_col_offset)
            qualified = '.'.join(scope + [node.name])
            references.append({'path': file, 'symbol': node.name, 'qualifiedName': qualified, 'startLine': start_line, 'endLine': node.end_lineno, 'body': source[start:end], 'oracle': 'python-stdlib-ast'})
            next_scope = scope + [node.name]
        for child in ast.iter_child_nodes(node):
            visit(child, next_scope)
    visit(root, [])
print(json.dumps({'references': references, 'errors': errors}))
