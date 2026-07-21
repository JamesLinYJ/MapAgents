import os, re
from pathlib import Path

ROOT = str(Path(__file__).resolve().parents[1] / 'apps' / 'web' / 'src')
GUARDS = os.path.join(ROOT, 'shared', 'utils', 'guards.ts')
FILES = [
    'features/conversation/items.ts',
    'features/conversation/ConversationEntry.tsx',
    'features/runs/useRunState.ts',
    'features/layers/useLayerManager.ts',
    'api/authClient.ts',
    'api/errors.ts',
    'features/tools/ToolMiniApp.tsx',
    'features/tools/ToolManagementPage.tsx',
]

PATTERN = r'(?:export )?function isRecord\(value: unknown\): value is Record<string, unknown> \{\s*\n\s*return typeof value === .object. && value !== null && !Array\.isArray\(value\)\s*\n\s*\}'

count = 0
for f in FILES:
    path = os.path.join(ROOT, f)
    if not os.path.exists(path):
        print(f'SKIP (not found): {f}')
        continue
    with open(path, 'r', encoding='utf-8') as fh:
        src = fh.read()
    if not re.search(PATTERN, src):
        print(f'SKIP (no match): {f}')
        continue
    src = re.sub(r'\n' + PATTERN, '', src)
    src = re.sub(PATTERN + r'\n', '', src)
    src = re.sub(PATTERN, '', src)

    rel = os.path.relpath(GUARDS, os.path.dirname(path))
    rel = rel.replace('\\', '/').replace('.ts', '')
    if not rel.startswith('.'):
        rel = './' + rel

    import_line = f"import {{ isRecord }} from '{rel}'"

    if import_line in src:
        print(f'SKIP (already imported): {f}')
        continue

    lines = src.split('\n')
    last_import = -1
    for i, line in enumerate(lines):
        if line.startswith('import ') or (line.startswith('export {') and 'from' in line):
            last_import = i
    if last_import >= 0:
        lines.insert(last_import + 1, import_line)
    else:
        lines.insert(0, import_line)

    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines))
    count += 1
    print(f'OK: {f} -> {rel}')

print(f'\nTotal: {count}')
