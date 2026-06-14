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

// ── Privacy: redact sensitive strings ─────────────────────────────────────────
// Replace a search query or user identifier with a short anonymous hash token.
// Two calls with the same input produce the same token within a process restart,
// so you can correlate log lines without ever seeing the real content.
// Example: redact("step mom") → "[#d4e1a2]"
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).slice(0, 6).padStart(6, '0');
}
export function redact(str) {
  if (!str) return '[empty]';
  return `[#${fnv1a(String(str))}]`;
}

// Redact a URL: keep only the hostname, drop the path/query (which may contain search terms).
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.hostname}/…`;
  } catch {
    return '[url]';
  }
}

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
