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
  coverageThreshold: {
    global: {statements: 77.21, branches: 66.56, functions: 77.61, lines: 77.77},
  },
};
