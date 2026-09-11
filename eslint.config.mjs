import {readFileSync} from 'node:fs';
import {dirname, basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import eslint from '@eslint/js';
import markdown from '@eslint/markdown';
import reLint from '@re-cinq/eslint-plugin-re-lint';
import tseslint from 'typescript-eslint';
import {parse as parseYaml} from 'yaml';

// layers.yaml is the readable declaration of the architecture; this hands it
// to no-cross-layer-import.
//
// The rule keys packages by `<package>/src/`, which suits a monorepo of
// packages and not a single package whose code sits at ./src. Left to find
// layers.yaml itself the rule would resolve every file as `src/...`, match no
// package, and report nothing - adopted in appearance, enforcing nothing. So
// the entries are re-homed under this checkout's own directory name with the
// root moved one level up, which is the shape the matcher expects.
//
// Paths come from this file's own URL rather than process.cwd(), so running
// eslint from a subdirectory cannot silently disable the rule.
// scripts/eslint-layers.test.ts fails if this ever stops reporting.
const repoRoot = dirname(fileURLToPath(import.meta.url));
const declaredLayers = parseYaml(readFileSync(join(repoRoot, 'layers.yaml'), 'utf8')).layers.src;

// Shared with eslint.config.backlog.mjs, which lints the same tree under the
// two rules held out of the blocking gate. One list, so the two configs cannot
// drift into disagreeing about what is even a source file.
//
// .claude/** is vendored agent tooling, maintained upstream rather than
// here, so a change there must not be able to redden this repo's CI.
export const ignores = [
  'node_modules/**',
  'dist/**',
  'coverage/**',
  '.claude/**',
  // Deliberately broken specs and ADRs - dead links, absent lead paragraphs,
  // statuses no parser reads - kept as the fixtures the script tests assert
  // against. Linting them would report the very faults they exist to reproduce.
  'scripts/fixtures/**',
];

export default tseslint.config(
  {ignores},
  {
    // Scoped to TypeScript now that markdown is linted too: an unscoped block
    // applies to every language, and JS rules do not survive a markdown AST.
    files: ['**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    plugins: {'re-lint': reLint},
    rules: {
      // CLAUDE.md leads with five mandatory layers and "no cross-layer
      // shortcuts, no circular deps". layers.yaml states that as data and this
      // rule enforces it, so the architecture is a file someone can read rather
      // than a habit that erodes.
      're-lint/no-cross-layer-import': [
        'error',
        {root: dirname(repoRoot), layers: {[basename(repoRoot)]: declaredLayers}},
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: false,
        },
      ],
      camelcase: 'error',
      // CLAUDE.md: "Tests live next to source: src/**/*.test.ts". True of all
      // ten test files today; this keeps it true.
      're-lint/require-colocated-tests': 'error',
      're-lint/no-commented-out-code': 'error',
      // The provider layer must surface failures as AIError rather than
      // swallowing them and fabricating a return value (CLAUDE.md, Adding a
      // provider).
      're-lint/no-catch-as-control-flow': 'error',
      // Markdown is excluded because a doc quoting the code it documents is
      // the intended state: README's example of createHalEngine and the
      // interface blocks in specs/ are *supposed* to match src/. jscpd extracts
      // fenced blocks and reports them as clones, so without this every
      // accurate code sample is a lint error and the incentive is to let the
      // docs drift. The same exclusion a jscpd config would carry; it lives
      // here rather than in a .jscpd.json because the rule reads `ignore` from
      // its own options and never from a config file.
      're-lint/no-duplicate-code': ['error', {ignore: ['**/*.md']}],
      're-lint/callee-below-caller': 'error',
      're-lint/declare-near-use': 'error',
      're-lint/default-export-matches-filename': 'error',
      're-lint/max-boolean-operators': 'error',
      're-lint/max-comment-lines': 'error',
      're-lint/max-member-chain': 'error',
      're-lint/no-closing-brace-comments': 'error',
      're-lint/no-flag-params': 'error',
      // INERT, kept as a placeholder. It needs type information and this config
      // gives it none, so it reports nothing - verified with a textbook
      // forwarding class, which it does not flag. The rule's own docs record the
      // same finding for the same reason. It becomes a real guardrail only if
      // this config adopts parserOptions.projectService; until then it is not
      // one, and a clean run says nothing about forwarding classes.
      're-lint/no-forwarding-class': 'error',
      're-lint/no-hybrid-class': 'error',
      're-lint/no-negative-names': 'error',
      're-lint/no-nested-if': 'error',
      're-lint/no-nested-loop': 'error',
      're-lint/no-reexport-only-module': 'error',
      're-lint/no-vague-names': 'error',
      're-lint/prefer-early-return': 'error',
      're-lint/prefer-polymorphism': 'error',
      're-lint/require-fetch-timeout': 'error',
      'no-console': 'error',
      // Providers are loaded lazily so that selecting one never forces its SDK
      // on consumers of the others, and the factories doing it are synchronous
      // (`createProvider`, `createBedrockProvider`) - dynamic `import()` would
      // make them async, which is a breaking API change. The rule stays on and
      // still rejects every other `require()`; only these paths are permitted.
      '@typescript-eslint/no-require-imports': [
        'error',
        {allow: ['^\\./(bedrock|vertex|openai|anthropic|mock)/index\\.js$', '^@aws-sdk/client-bedrock-runtime$']},
      ],
    },
  },
  // Rules that only make sense on a test file.
  {
    // require-spec-link gates here: every test in
    // the suite cites a spec statement, so the backlog it once measured is
    // empty and an uncited new test is now a build failure rather than a
    // number. Its statement-side mirror stays a report - see
    // eslint.config.backlog.mjs.
    files: ['**/*.test.ts'],
    plugins: {'re-lint': reLint},
    rules: {
      're-lint/require-spec-link': 'error',
      're-lint/max-expects': 'error',
      're-lint/no-nondeterministic-tests': 'error',
      're-lint/test-imports-its-subject': 'error',
    },
  },
  // Every markdown link to a repo file must land. A rename sweep rewrites a
  // dead link faithfully and the reference still reads as current, which is
  // exactly how the spec restructure could have gone wrong.
  {
    files: ['**/*.md'],
    language: 'markdown/gfm',
    plugins: {markdown, 're-lint': reLint},
    rules: {'re-lint/no-dead-md-links': 'error'},
  },
  // AGENTS.md § Spec Header Table: every spec and ADR opens with a lead
  // paragraph, and a spec's `| Status |` row must match its test-citation
  // coverage. ADRs are exempt from the coverage tier - asking a decision
  // record to cite a test for every statement it makes is the wrong ask - so
  // the second rule is scoped to specs alone.
  {
    files: ['specs/**/spec.md', 'adrs/*.md', 'scripts/fixtures/spec-status/**/*.md'],
    language: 'markdown/gfm',
    plugins: {markdown, 're-lint': reLint},
    rules: {'re-lint/require-intro-paragraph': 'error'},
  },
  {
    files: ['specs/**/spec.md', 'scripts/fixtures/spec-status/specs/**/spec.md'],
    language: 'markdown/gfm',
    plugins: {markdown, 're-lint': reLint},
    // require-statement-links belongs to this pair but is deliberately absent:
    // see eslint.config.backlog.mjs.
    rules: {'re-lint/require-status-matches-coverage': 'error'},
  }
);
