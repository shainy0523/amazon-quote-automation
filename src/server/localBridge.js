'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Talks to the browser extension (extension/) that runs INSIDE the user's
 * real, already-open Chrome tab. There is no way for an external tool to
 * attach to an already-running Chrome instance (verified directly — Chrome
 * blocks remote debugging against a live/default profile), so instead of
 * launching a separate browser, this server hands the extension a job
 * (records + quoteUrl) and receives progress back, while the extension's
 * content script does the actual page automation in the user's own tab.
 *
 * Bound to 127.0.0.1 only — never exposed on the network.
 */
class LocalBridge {
  constructor({ onProgress, onStatus, onLog, onComplete, logDir } = {}) {
    this.server = null;
    this.port = null;
    this.currentJob = null; // { jobId, quoteUrl, records, claimed, stopRequested }
    this.logDir = logDir;
    this.onProgress = onProgress || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});
    this.onComplete = onComplete || (() => {});
    this._jobEvents = new EventEmitter();
    this._jobEvents.setMaxListeners(50);
  }

  start(preferredPort = 47654) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(preferredPort, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  /**
   * Queues a new job for the extension to pick up on its next poll.
   * `targetBrowser` ('chrome' | 'firefox') restricts which browser's
   * extension instance may claim it — if the extension is loaded in both
   * browsers at once, only the one the user picked in the UI gets it.
   */
  createJob({ quoteUrl, records, targetBrowser }) {
    const jobId = crypto.randomUUID();
    this.currentJob = { jobId, quoteUrl, records, targetBrowser, claimed: false, stopRequested: false };
    this._jobEvents.emit('job');
    return jobId;
  }

  /** Resolves once a job is available and unclaimed, or after timeoutMs. */
  _waitForJob(timeoutMs) {
    if (this.currentJob && !this.currentJob.claimed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._jobEvents.off('job', onJob);
        resolve();
      }, timeoutMs);
      const onJob = () => {
        clearTimeout(timer);
        resolve();
      };
      this._jobEvents.once('job', onJob);
    });
  }

  requestStop() {
    if (this.currentJob) this.currentJob.stopRequested = true;
  }

  _send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(json);
  }

  async _readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 5_000_000) req.destroy();
      });
      req.on('end', () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  _saveScreenshot(asin, dataUrl) {
    if (!this.logDir || !dataUrl) return null;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const file = path.join(this.logDir, `failure-${asin}-${Date.now()}.png`);
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
      return file;
    } catch {
      return null;
    }
  }

  _handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

    if (req.method === 'OPTIONS') {
      return this._send(res, 204, {});
    }

    if (req.method === 'GET' && url.pathname === '/api/job') {
      const requestingBrowser = url.searchParams.get('browser') || null;
      // Long-polls for up to 25s so the extension gets a near-instant
      // hand-off without needing sub-second polling (MV3 service workers
      // are killed when idle, but a pending fetch keeps one alive).
      this._waitForJob(25000).then(() => {
        if (!this.currentJob || this.currentJob.claimed) {
          return this._send(res, 204, {});
        }
        if (
          this.currentJob.targetBrowser &&
          requestingBrowser &&
          this.currentJob.targetBrowser !== requestingBrowser
        ) {
          // Job exists but is earmarked for the other browser — nothing
          // for this poller right now.
          return this._send(res, 204, {});
        }
        this.currentJob.claimed = true;
        const { jobId, quoteUrl, records } = this.currentJob;
        this._send(res, 200, { jobId, quoteUrl, records });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/shouldStop') {
      const jobId = url.searchParams.get('jobId');
      const stop = !!(this.currentJob && this.currentJob.jobId === jobId && this.currentJob.stopRequested);
      return this._send(res, 200, { stop });
    }

    if (req.method === 'POST' && url.pathname === '/api/progress') {
      this._readJsonBody(req)
        .then((body) => {
          this.onProgress(body);
          this._send(res, 200, { ok: true });
        })
        .catch(() => this._send(res, 400, { ok: false }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/status') {
      this._readJsonBody(req)
        .then((body) => {
          this.onStatus(body);
          this._send(res, 200, { ok: true });
        })
        .catch(() => this._send(res, 400, { ok: false }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/log') {
      this._readJsonBody(req)
        .then((body) => {
          this.onLog(body.line || '');
          this._send(res, 200, { ok: true });
        })
        .catch(() => this._send(res, 400, { ok: false }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/screenshot') {
      this._readJsonBody(req)
        .then((body) => {
          const file = this._saveScreenshot(body.asin, body.dataUrl);
          this.onLog(file ? `Saved failure screenshot: ${file}` : `Could not save screenshot for ${body.asin}`);
          this._send(res, 200, { ok: true, file });
        })
        .catch(() => this._send(res, 400, { ok: false }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/complete') {
      this._readJsonBody(req)
        .then((body) => {
          this.onComplete(body);
          this.currentJob = null;
          this._send(res, 200, { ok: true });
        })
        .catch(() => this._send(res, 400, { ok: false }));
      return;
    }

    this._send(res, 404, { error: 'Not found' });
  }
}

module.exports = LocalBridge;
