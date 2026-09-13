export interface Logger {
  debug(category: string, message: string, fields?: Record<string, unknown>): void;
  info(category: string, message: string, fields?: Record<string, unknown>): void;
  warn(category: string, message: string, fields?: Record<string, unknown>): void;
  error(category: string, message: string, fields?: Record<string, unknown>): void;
}

const LOG_LEVELS = {DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3} as const;
type LevelName = keyof typeof LOG_LEVELS;

const METHODS = {DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error'} as const;

const resolvedLevel = (() => {
  const env = (process.env.LOG_LEVEL || 'info').toUpperCase();
  return LOG_LEVELS[env as LevelName] ?? LOG_LEVELS.INFO;
})();

export const UNSERIALISABLE = '[unserialisable]';

function emit(level: LevelName, category: string, message: string, fields?: Record<string, unknown>): void {
  // Caller fields are nested under `data`, so one named `severity` cannot overwrite the line's own.
  const line = {
    severity: level,
    message,
    timestamp: new Date().toISOString(),
    category,
    ...(fields ? {data: fields} : {}),
  };

  // ERROR to stderr: a stream that cannot be split by severity cannot be alerted on.
  // eslint-disable-next-line no-console -- the one place this package writes to a stream
  (level === 'ERROR' ? console.error : console.log)(serialise(line));
}

// A throw here would take down the call site being observed, so an unserialisable field costs that field alone.
function serialise(line: Record<string, unknown>): string {
  const whole = probe(() => JSON.stringify(line));
  if (whole.ok) return whole.value;

  // String() runs the caller's toString, so it is attempted inside the probe rather than before it.
  const degraded = probe(() =>
    JSON.stringify({
      severity: line.severity,
      message: String(line.message),
      timestamp: line.timestamp,
      category: String(line.category),
      data: `${UNSERIALISABLE}: ${whole.reason}`,
    })
  );
  if (degraded.ok) return degraded.value;

  // Nothing the caller supplied survives into this one, so it cannot fail in turn.
  return JSON.stringify({
    severity: line.severity,
    message: UNSERIALISABLE,
    timestamp: line.timestamp,
    category: UNSERIALISABLE,
    data: `${UNSERIALISABLE}: ${degraded.reason}`,
  });
}

// A probe, not control flow: it reports what happened rather than branching on a swallowed error.
function probe(run: () => string): {ok: true; value: string} | {ok: false; reason: string} {
  try {
    return {ok: true, value: run()};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {ok: false, reason: reason.split('\n')[0]};
  }
}

const consoleLogger: Logger = {
  debug: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('DEBUG', category, message, fields),
  info: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('INFO', category, message, fields),
  warn: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('WARN', category, message, fields),
  error: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('ERROR', category, message, fields),
};

let active: Logger = consoleLogger;

// Process-global by design: every module that logs imports `log` at module scope, so there is one.
export function setLogger(logger?: Logger): void {
  // Handed `log` itself, the delegate below would call itself until the stack ran out, so that reads as none.
  active = logger === undefined || logger === log ? consoleLogger : logger;
}

// The one place a level is tested, so LOG_LEVEL gates a supplied logger exactly as it gates the built-in one.
function dispatch(level: LevelName, category: string, message: string, fields?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < resolvedLevel) return;

  const delivered = probe(() => {
    active[METHODS[level]](category, message, fields);
    return '';
  });
  if (delivered.ok) return;

  // A supplied logger that throws must not take down the call site it observes, and the line is not dropped.
  probe(() => {
    emit(level, category, message, fields);
    return '';
  });
}

// Delegating rather than reassigned, so a module that imported `log` before the swap still sees it.
export const log: Logger = {
  debug: (category: string, message: string, fields?: Record<string, unknown>) =>
    dispatch('DEBUG', category, message, fields),
  info: (category: string, message: string, fields?: Record<string, unknown>) =>
    dispatch('INFO', category, message, fields),
  warn: (category: string, message: string, fields?: Record<string, unknown>) =>
    dispatch('WARN', category, message, fields),
  error: (category: string, message: string, fields?: Record<string, unknown>) =>
    dispatch('ERROR', category, message, fields),
};
