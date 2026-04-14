import fs from 'fs';
import path from 'path';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

// --- Rotating file appender (1 MB cap) ---
const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'nanoclaw.log');
const MAX_BYTES = 1_000_000; // ~1 MB

let logStream: fs.WriteStream | undefined;
let bytesWritten = 0;

function openLogStream(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Check current size
    try {
      const stat = fs.statSync(LOG_FILE);
      bytesWritten = stat.size;
    } catch {
      bytesWritten = 0;
    }
    if (bytesWritten >= MAX_BYTES) {
      rotateLog();
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch {
    // Can't open log file — fall back to stdout only
    logStream = undefined;
  }
}

function rotateLog(): void {
  try {
    const backup = `${LOG_FILE}.1`;
    try { fs.unlinkSync(backup); } catch { /* ignore */ }
    try { fs.renameSync(LOG_FILE, backup); } catch { /* ignore */ }
    bytesWritten = 0;
  } catch {
    // Rotation failed — truncate instead
    try {
      fs.truncateSync(LOG_FILE, 0);
      bytesWritten = 0;
    } catch { /* give up */ }
  }
}

function writeToFile(line: string): void {
  if (!logStream) return;
  const size = Buffer.byteLength(line, 'utf8');
  if (bytesWritten + size > MAX_BYTES) {
    logStream.end();
    rotateLog();
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  }
  logStream.write(line);
  bytesWritten += size;
}

openLogStream();

// --- Formatting helpers ---

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  let line: string;
  if (typeof dataOrMsg === 'string') {
    line = `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`;
  } else {
    line = `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`;
  }
  // Write colored to terminal
  stream.write(line);
  // Write plain-text to rotating log file
  writeToFile(stripAnsi(line));
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
