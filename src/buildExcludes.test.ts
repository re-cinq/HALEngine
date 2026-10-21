import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

describe('what the build emits', () => {
  it('emits no file only tests reach: one the package root never imports but a test does is left out of the build', () => {
    const {exclude} = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8')) as {exclude: string[]};
    const files = new Set(sourceFiles());
    const shipped = reachableFrom(['src/index.ts'], files);
    const tests = [...files].filter(file => file.endsWith('.test.ts'));
    const testOnly = [...reachableFrom(tests, files)].filter(file => !shipped.has(file) && !file.endsWith('.test.ts'));

    expect({
      sees: testOnly.includes('src/providers/providerTestSupport.ts'),
      emitted: testOnly.filter(file => !excludedFromBuild(file, exclude)).sort(),
    }).toEqual({sees: true, emitted: []});
  });

  it('emits only what the package root reaches: every file the build emits is imported, at some depth, from src/index.ts', () => {
    const {exclude} = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8')) as {exclude: string[]};
    const files = new Set(sourceFiles());
    const shipped = reachableFrom(['src/index.ts'], files);

    const emitted = [...files].filter(file => !excludedFromBuild(file, exclude));
    expect(emitted.filter(file => !shipped.has(file)).sort()).toEqual([]);
  });
});

// Every .ts file under src/, as a path from the repository root.
function sourceFiles(): string[] {
  const under = readdirSync(join(ROOT, 'src'), {recursive: true, encoding: 'utf8'});
  return under.filter(path => path.endsWith('.ts')).map(path => join('src', path));
}

// Every file in `files` that `entries` reach through relative imports, the entries included.
function reachableFrom(entries: string[], files: Set<string>): Set<string> {
  const seen = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...importsOf(file).filter(dependency => files.has(dependency)));
  }
  return seen;
}

function importsOf(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return [...text.matchAll(LOCAL_IMPORT)].map(([, specifier]) =>
    normalize(join(dirname(file), specifier)).replace(/\.js$/, '.ts')
  );
}

// The two shapes tsconfig.build.json uses: a `**/*` suffix, or a path or directory from the repository root.
function excludedFromBuild(file: string, patterns: string[]): boolean {
  return patterns.some(pattern =>
    pattern.startsWith('**/*')
      ? file.endsWith(pattern.slice('**/*'.length))
      : file === pattern || file.startsWith(`${pattern}/`)
  );
}
