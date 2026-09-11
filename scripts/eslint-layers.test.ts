/* eslint-disable re-lint/test-imports-its-subject -- loads eslint.config.mjs via spawnSync, which the rule cannot see (adrs/ADR-006-lint-suppressions.md) */
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

// Pins that the layering gate still REPORTS; its failure mode is silence (eslint.config.mjs).

const RULE = 're-lint/no-cross-layer-import';

const violationsFor = (filePath: string, code: string): string[] => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(process.cwd(), 'node_modules/eslint/bin/eslint.js'),
      '--stdin',
      '--stdin-filename',
      filePath,
      '--format',
      'json',
    ],
    {cwd: process.cwd(), input: code, encoding: 'utf8'}
  );

  const [report] = JSON.parse(result.stdout) as {messages: {ruleId: string | null; message: string}[]}[];

  const layering = report.messages.filter(message => message.ruleId === RULE);

  return layering.map(message => message.message);
};

const ORCHESTRATION_TO_PROVIDER =
  "import {createMockProvider} from '../providers/mock/index.js';\nexport const probe = createMockProvider;\n";
const TYPES_TO_TRANSPORT =
  "import {createServer} from '../transport/createServer.js';\nexport const probe = createServer;\n";
const TYPES_TO_SHARED = "import {log} from '../shared/logger.js';\nexport const probe = log;\n";
const SHARED_TO_TYPES = "import type {AIProvider} from '../types/ai.js';\nexport const probe: AIProvider | null = null;\n";

describe('the layering gate', () => {
  it('reports orchestration importing a concrete provider, the coupling the architecture forbids', () => {
    const messages = violationsFor('src/orchestration/probe.ts', ORCHESTRATION_TO_PROVIDER);

    expect(messages).toEqual([
      expect.stringMatching(/`orchestration` may not import `providers\/mock`.*allows: types, shared, infrastructure/),
    ]);
  });

  it('reports an upward import from the bottom layer, which may import nothing', () => {
    const messages = violationsFor('src/types/probe.ts', TYPES_TO_TRANSPORT);

    expect(messages).toEqual([expect.stringMatching(/`types` may not import `transport`.*allows: nothing/)]);
  });

  it('allows a downward import the layering declares', () => {
    const messages = violationsFor(
      'src/transport/probe.ts',
      "import {createChatOrchestrator} from '../orchestration/chatOrchestrator.js';\nexport const probe = createChatOrchestrator;\n"
    );

    expect(messages).toEqual([]);
  });

  it('reports a sibling import both ways, because providers and infrastructure are not a chain', () => {
    expect({
      down: violationsFor(
        'src/providers/probe.ts',
        "import {InMemorySessionStore} from '../infrastructure/stores/inMemorySessionStore.js';\nexport const probe = InMemorySessionStore;\n"
      ),
      up: violationsFor(
        'src/infrastructure/probe.ts',
        "import {createMockProvider} from '../providers/mock/index.js';\nexport const probe = createMockProvider;\n"
      ),
    }).toEqual({
      down: [expect.stringMatching(/`providers` may not import `infrastructure\/stores`.*allows: types, shared/)],
      up: [expect.stringMatching(/`infrastructure` may not import `providers\/mock`.*allows: types, shared/)],
    });
  });

  it('reports shared importing anything at all, so the cross-cutting layer stays a leaf', () => {
    const messages = violationsFor('src/shared/probe.ts', SHARED_TO_TYPES);

    expect(messages).toEqual([expect.stringMatching(/`shared` may not import `types`.*allows: nothing/)]);
  });

  it('lets every layer above types reach shared, but not types itself', () => {
    expect({
      fromTypes: violationsFor('src/types/probe.ts', TYPES_TO_SHARED),
      fromTransport: violationsFor('src/transport/probe.ts', TYPES_TO_SHARED),
    }).toEqual({
      fromTypes: [expect.stringMatching(/`types` may not import `shared`.*allows: nothing/)],
      fromTransport: [],
    });
  });

  it('lets the composition root at src/ see every layer, because assembling them is its job', () => {
    const messages = violationsFor(
      'src/probe.ts',
      "import {createServer} from './transport/createServer.js';\nexport const probe = createServer;\n"
    );

    expect(messages).toEqual([]);
  });

  it('gives a folder with no layers.yaml entry no imports at all', () => {
    const messages = violationsFor('src/newthing/probe.ts', SHARED_TO_TYPES);

    expect(messages).toEqual([
      expect.stringMatching(/`newthing` has no entry in layers.yaml, so it may import nothing/),
    ]);
  });

  it('governs files under src, so a matcher that silently matches nothing fails here', () => {
    expect({
      underSrc: violationsFor('src/types/probe.ts', TYPES_TO_TRANSPORT),
      outsideSrc: violationsFor('example/probe.ts', TYPES_TO_TRANSPORT),
    }).toEqual({underSrc: [expect.any(String)], outsideSrc: []});
  });
});
