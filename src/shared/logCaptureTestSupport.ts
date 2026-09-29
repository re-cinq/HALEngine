import {setLogger} from './logger.js';

// Shared by the suites that assert on a logged line rather than on a return value.
/** Installs a silent logger for the surrounding suite and returns the array its `error` lines land in. */
export function captureErrors(): Array<Record<string, unknown>> {
  const errors: Array<Record<string, unknown>> = [];
  const quiet = () => undefined;

  beforeEach(() => {
    errors.length = 0;
    setLogger({
      debug: quiet,
      info: quiet,
      warn: quiet,
      error: (category, message, fields) => void errors.push({category, message, ...fields}),
    });
  });

  afterEach(() => setLogger());

  return errors;
}
