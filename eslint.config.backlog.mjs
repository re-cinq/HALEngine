import markdown from '@eslint/markdown';
import reLint from '@re-cinq/eslint-plugin-re-lint';
import tseslint from 'typescript-eslint';
import {ignores} from './eslint.config.mjs';

// `re-lint/require-statement-links` at `warn`, which is the severity
// The intended severity for it: a testable statement with no test link is a
// deterministic, always-on signal that never wedges the pipeline, raised to
// `error` per repo once the corpus is backfilled.
//
// It cannot live in eslint.config.mjs, because `npm run eslint` runs
// --max-warnings 0 and a warning there is red. So the rule runs from this
// config, under a script with no such flag, and `npm run lint:backlog` exits 0
// while printing the count. Some adopters decline the rule outright for
// exactly this reason - it has one config and gates at zero warnings, so `warn`
// was not available to it.
//
// The test-side mirror, `require-spec-link`, is NOT here: it is satisfied and
// gates in eslint.config.mjs. Nothing else belongs in this file - a rule moved
// here to escape a red gate is a rule nobody will fix.
export default tseslint.config(
  // Alone in its object, never beside another key: a flat-config entry holding
  // `ignores` and anything else is a file filter for that entry rather than the
  // tree's global ignore list, which quietly puts node_modules and dist back in
  // scope.
  {ignores},
  {
    // This config enables one rule, so every eslint-disable in the tree targets
    // a rule it does not run and each would be reported here as unused.
    // eslint.config.mjs is the authority on directives.
    linterOptions: {reportUnusedDisableDirectives: 'off'},
  },
  {
    files: ['specs/**/spec.md'],
    language: 'markdown/gfm',
    plugins: {markdown, 're-lint': reLint},
    rules: {'re-lint/require-statement-links': 'warn'},
  }
);
