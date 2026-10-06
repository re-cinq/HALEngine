import {setLogger} from './logger.js';

// Shared by the suites that assert on a logged line rather than on a return value.
/** Installs a silent logger for the surrounding suite and returns the array its `error` lines land in. */
export function captureErrors(): Array<Record<string, unknown>> {
  return captureLog().errors;
}

/** Both levels from one installed logger: two captures in one suite would fight over who the logger is. */
export function captureLog(): {errors: Array<Record<string, unknown>>; warnings: Array<Record<string, unknown>>} {
  const errors: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const quiet = () => undefined;
  const into =
    (lines: Array<Record<string, unknown>>) =>
    (category: string, message: string, fields?: Record<string, unknown>): void =>
      void lines.push({category, message, ...fields});

  beforeEach(() => {
    errors.length = 0;
    warnings.length = 0;
    setLogger({debug: quiet, info: quiet, warn: into(warnings), error: into(errors)});
  });

  afterEach(() => setLogger());

  return {errors, warnings};
}
