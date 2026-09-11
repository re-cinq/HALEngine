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
  (level === 'ERROR' ? console.error : console.log)(JSON.stringify(line));
}

export const log: Logger = {
  debug: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('DEBUG', category, message, fields),
  info: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('INFO', category, message, fields),
  warn: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('WARN', category, message, fields),
  error: (category: string, message: string, fields?: Record<string, unknown>) =>
    emit('ERROR', category, message, fields),
};
