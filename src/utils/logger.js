'use strict';

/**
 * Simple in-memory + emitting logger.
 * Main process calls log(); a callback (set via onLog) forwards
 * each entry to the renderer over IPC. Never log credentials or
 * cookie/session data — only high-level status strings.
 */
class Logger {
  constructor() {
    this.entries = [];
    this._listener = null;
  }

  onLog(fn) {
    this._listener = fn;
  }

  _timestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  log(message) {
    const line = `[${this._timestamp()}] ${message}`;
    this.entries.push(line);
    if (this._listener) this._listener(line);
    return line;
  }

  getAll() {
    return this.entries;
  }
}

module.exports = new Logger();
