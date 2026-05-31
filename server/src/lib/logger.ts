type Level = 'debug' | 'info' | 'warn' | 'error';

const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = levels[(process.env.LOG_LEVEL as Level) ?? 'info'];

function fmt(level: Level, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] ${msg}`;
  return meta !== undefined ? `${base} ${JSON.stringify(meta)}` : base;
}

export const logger = {
  debug: (msg: string, meta?: unknown) => levels.debug >= minLevel && console.debug(fmt('debug', msg, meta)),
  info:  (msg: string, meta?: unknown) => levels.info  >= minLevel && console.info(fmt('info',  msg, meta)),
  warn:  (msg: string, meta?: unknown) => levels.warn  >= minLevel && console.warn(fmt('warn',  msg, meta)),
  error: (msg: string, meta?: unknown) => levels.error >= minLevel && console.error(fmt('error', msg, meta)),
};
