/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // NodeNext source writes `./x.js` for `./x.ts`; jest resolves the real file.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {useESM: true}],
  },
  // src/ only: the scripts/ suites drive their subjects through spawnSync, so an
  // instrumented .mjs would report zero regardless of how well it is tested.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/providers/providerTestSupport.ts'],
  // A ratchet, not a target: these are exactly what the suite measured when the
  // gate landed, so any drop fails and any rise should move them up with it. A
  // red run is fixed by adding the missing test, never by lowering the number
  // (specs/hal-engine-npm-release/spec.md).
  // The one exception: deleting covered code shrinks the denominator and lowers
  // the percentage while the uncovered count is unchanged. Compare covered/total
  // absolutes before re-baselining, and say so in the commit.
  // Per-path floors for the four directories that have tests, so a regression concentrated in one
  // module cannot hide inside a global figure the rest of the tree holds up. Set at 70, the review bar
  // in AGENTS.md, rather than at measurement: all four sit well above it and the global row is the ratchet.
  // Naming a path REMOVES its files from the `global` group, so the global numbers below cover the
  // remainder - the provider adapters and ws helpers that have no suite - and are lower than the
  // whole-tree figure for that reason alone, not because coverage fell.
  coverageThreshold: {
    global: {statements: 71.48, branches: 59.42, functions: 68.57, lines: 71.9},
    'src/orchestration/': {statements: 70, branches: 70, functions: 70, lines: 70},
    'src/infrastructure/stores/': {statements: 70, branches: 70, functions: 70, lines: 70},
    'src/providers/vertex/': {statements: 70, branches: 65, functions: 70, lines: 70},
    'src/providers/mock/': {statements: 70, branches: 70, functions: 70, lines: 70},
  },
};
