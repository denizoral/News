// Mirrors console output to <DATA_DIR>/logs/server.log so it survives
// restarts (and containers that discard stdout), rotating at 10 MB with two
// old files kept. Also records fatal errors before the process exits.

import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 2;

export function startFileLog(dir = path.resolve(process.env.DATA_DIR || 'data', 'logs')) {
  if (process.env.LOG_FILE === 'off') return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'server.log');
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let fd = fs.openSync(file, 'a');

  const rotate = () => {
    fs.closeSync(fd);
    for (let i = KEEP; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i}`);
    }
    fd = fs.openSync(file, 'a');
    size = 0;
  };

  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${util.format(...args)}\n`;
    try {
      fs.writeSync(fd, line);
      size += Buffer.byteLength(line);
      if (size > MAX_BYTES) rotate();
    } catch { /* a full disk must not take the server down */ }
  };

  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(level, args);
    };
  }

  // Crash-only: record the error, then exit so a supervisor (Docker, systemd)
  // restarts from the persisted state instead of running in an unknown state.
  process.on('uncaughtException', (err) => {
    write('FATAL', ['uncaught exception:', err?.stack || err]);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    write('ERROR', ['unhandled promise rejection:', err?.stack || err]);
  });
  write('INFO', [`server starting (pid ${process.pid}, node ${process.version})`]);
  return file;
}
