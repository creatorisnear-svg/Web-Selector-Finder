const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_LABELS = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR' };
const COLORS = {
  10: '\x1b[36m',
  20: '\x1b[32m',
  30: '\x1b[33m',
  40: '\x1b[31m'
};
const RESET = '\x1b[0m';

const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function formatArg(arg) {
  if (arg instanceof Error) return `${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
  if (typeof arg === 'object' && arg !== null) {
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }
  return String(arg);
}

function log(level, ...args) {
  if (level < MIN_LEVEL) return;
  const ts = new Date().toISOString();
  const label = LEVEL_LABELS[level] ?? 'LOG';
  const color = COLORS[level] ?? '';
  const msg = args.map(formatArg).join(' ');
  const line = `${color}[${ts}] [${label}]${RESET} ${msg}`;
  if (level >= LEVELS.error) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export const logger = {
  debug: (...args) => log(LEVELS.debug, ...args),
  info:  (...args) => log(LEVELS.info,  ...args),
  warn:  (...args) => log(LEVELS.warn,  ...args),
  error: (...args) => log(LEVELS.error, ...args),
};
