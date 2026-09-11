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
  const timestamp = new Date().toISOString();
  const payload = fields ? ` ${JSON.stringify(fields)}` : '';
  // eslint-disable-next-line no-console
  console.log(`[${timestamp}] [${level}] [${category}] ${message}${payload}`);
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
