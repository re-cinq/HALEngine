export interface Logger {
  debug(category: string, message: string, fields?: Record<string, unknown>): void;
  info(category: string, message: string, fields?: Record<string, unknown>): void;
  warn(category: string, message: string, fields?: Record<string, unknown>): void;
  error(category: string, message: string, fields?: Record<string, unknown>): void;
}

const LOG_LEVELS = {DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3} as const;
type LevelName = keyof typeof LOG_LEVELS;

const resolvedLevel = (() => {
  const env = (process.env.LOG_LEVEL || 'info').toUpperCase();
  return LOG_LEVELS[env as LevelName] ?? LOG_LEVELS.INFO;
})();

export const UNSERIALISABLE = '[unserialisable]';

function emit(level: LevelName, category: string, message: string, fields?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < resolvedLevel) return;

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
  const attempt = stringify(line);
  if (attempt.ok) return attempt.text;

  // Primitives only, so this one cannot fail in turn.
  return JSON.stringify({
    severity: line.severity,
    message: String(line.message),
    timestamp: line.timestamp,
    category: String(line.category),
    data: `${UNSERIALISABLE}: ${attempt.reason}`,
  });
}

// A probe, not control flow: JSON.stringify throws on cycles and BigInt, and the reason is worth keeping.
function stringify(value: unknown): {ok: true; text: string} | {ok: false; reason: string} {
  try {
    return {ok: true, text: JSON.stringify(value)};
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

// Process-global by design: seven modules import `log` at module scope, so there is one per process.
export function setLogger(logger?: Logger): void {
  active = logger ?? consoleLogger;
}

// Delegating rather than reassigned, so a module that imported `log` before the swap still sees it.
export const log: Logger = {
  debug: (category: string, message: string, fields?: Record<string, unknown>) =>
    active.debug(category, message, fields),
  info: (category: string, message: string, fields?: Record<string, unknown>) => active.info(category, message, fields),
  warn: (category: string, message: string, fields?: Record<string, unknown>) => active.warn(category, message, fields),
  error: (category: string, message: string, fields?: Record<string, unknown>) =>
    active.error(category, message, fields),
};
