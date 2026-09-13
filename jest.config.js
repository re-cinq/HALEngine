/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['**/*.test.ts'],
  // Fixture suites are inputs to the gate tests, not tests; one of them is deliberately skipped.
  testPathIgnorePatterns: ['/node_modules/', '/scripts/fixtures/'],
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
  // Per-path floors set at measurement, exactly as the global row is. An earlier version set them at
  // 70 with a comment claiming all four sat well above it - vertex's branches were 69.23, below it, and
  // four groups gained an 18-to-30 point regression budget the single global floor had never allowed.
  // `src/orchestration/tools/` is named separately because a path floor is a prefix match: without it a
  // regression in the tools registry hides inside the orchestration figure, which is what these exist
  // to prevent. Naming a path REMOVES its files from the `global` group, so the global numbers below
  // cover the remainder - the provider adapters and ws helpers with no suite - and are lower for that
  // reason rather than because coverage fell. Raise any of these with the measurement; never lower one
  // to go green (specs/hal-engine-npm-release/spec.md).
  coverageThreshold: {
    'src/orchestration/': {statements: 88.3, branches: 85.91, functions: 92, lines: 87.91},
    'src/orchestration/tools/': {statements: 66.66, branches: 57.14, functions: 71.42, lines: 70.83},
    'src/infrastructure/stores/': {statements: 100, branches: 100, functions: 100, lines: 100},
    'src/providers/vertex/': {statements: 87.95, branches: 69.23, functions: 93.33, lines: 91.78},
    'src/providers/mock/': {statements: 100, branches: 75, functions: 100, lines: 100},
    global: {statements: 71.48, branches: 59.42, functions: 68.57, lines: 71.9},
  },
};
