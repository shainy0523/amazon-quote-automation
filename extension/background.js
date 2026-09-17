'use strict';

// MV2 background page (see manifest.json — "persistent": true), not an
// MV3 service worker, specifically so this same extension loads
// identically in both Chrome ("Load unpacked") and Firefox ("Load
// Temporary Add-on"). A persistent background page never gets suspended,
// so a plain infinite polling loop is enough — no keep-alive workarounds
// needed. `chrome.*` is used throughout because Firefox implements it as
// a compatibility alias for the same callback-based API surface.

// Fixed port the desktop app's local bridge server listens on
// (src/server/localBridge.js). Must match on both sides.
const BASE_URL = 'http://127.0.0.1:47654';

// Firefox exposes the promise-based `browser` namespace natively; Chrome
// does not. Used so the desktop app can target "chrome" or "firefox"
// specifically when the extension is loaded in both at once (radio button
// in the app's UI) instead of whichever instance happens to poll first.
const BROWSER_NAME = typeof browser !== 'undefined' ? 'firefox' : 'chrome';

let activeTabId = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLoop() {
  console.log(`[AmazonQuoteAutomation] poll loop starting, browser=${BROWSER_NAME}, base=${BASE_URL}`);
  for (;;) {
    try {
      // This fetch is a long-poll (server holds it open up to ~25s
      // waiting for a job), so jobs are picked up near-instantly without
      // needing frequent polling.
      const res = await fetch(`${BASE_URL}/api/job?browser=${BROWSER_NAME}`);
      console.log(`[AmazonQuoteAutomation] poll response status=${res.status}`);
      if (res.status === 200) {
        const job = await res.json();
        console.log('[AmazonQuoteAutomation] job received', job);
        await runJob(job);
      } else {
        // 204: either no job, or one exists but is earmarked for the
        // other browser — small delay so that case doesn't busy-loop.
        await sleep(1000);
      }
    } catch (err) {
      // Desktop app likely isn't running yet — back off and retry.
      console.error('[AmazonQuoteAutomation] poll fetch failed:', err);
      await sleep(3000);
    }
  }
}

async function runJob(job) {
  const tab = await findOrCreateAmazonTab(job.quoteUrl);
  activeTabId = tab.id;
  await waitForTabComplete(tab.id);
  const delivered = await sendJobWithRetry(tab.id, job);
  console.log(`[AmazonQuoteAutomation] RUN_JOB delivered=${delivered}`);
}

// Amazon's pages are heavy React SPAs — "tab complete" fires well before
// content.js has actually finished loading and registered its message
// listener, so a single fire-and-forget send after a fixed delay can
// silently land before anyone is listening. Retry with acknowledgment
// instead of guessing a fixed delay.
function sendJobWithRetry(tabId, job, attemptsLeft = 15, delayMs = 1000) {
  return new Promise((resolve) => {
    const tryOnce = (remaining) => {
      chrome.tabs.sendMessage(tabId, { type: 'RUN_JOB', job }, (response) => {
        const failed = chrome.runtime.lastError || !response || !response.ok;
        if (!failed) return resolve(true);
        if (remaining <= 0) return resolve(false);
        setTimeout(() => tryOnce(remaining - 1), delayMs);
      });
    };
    tryOnce(attemptsLeft);
  });
}

// True for any Amazon domain/subdomain (amazon.com, www.amazon.com,
// amazon.co.uk, smile.amazon.com, etc.) — deliberately broad so an
// already-open Amazon tab is always found and reused rather than opening
// a new one. Uses real hostname parsing (not a loose regex) so a
// lookalike domain like amazon.com.evil.com does NOT match.
function isAmazonUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return /^([a-z0-9-]+\.)*amazon\.[a-z]{2,}(\.[a-z]{2,})?$/.test(hostname);
  } catch {
    return false;
  }
}

function findOrCreateAmazonTab(quoteUrl) {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      const existing = tabs.find((t) => t.url && isAmazonUrl(t.url));
      if (existing) {
        const alreadyOnQuoteUrl = existing.url === quoteUrl;
        chrome.tabs.update(existing.id, { active: true, url: quoteUrl }, (tab) => {
          if (alreadyOnQuoteUrl) {
            // Navigating to the same URL the tab is already on is a no-op —
            // no real page load happens, so content.js (injected only on
            // navigation) would never run. Force a reload so it always does,
            // instead of relying on the user manually refreshing the tab.
            chrome.tabs.reload(tab.id, {}, () => resolve(tab));
          } else {
            resolve(tab);
          }
        });
      } else {
        chrome.tabs.create({ url: quoteUrl }, (tab) => resolve(tab));
      }
    });
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (tab && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function postJSON(path, body) {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'SHOULD_STOP') {
    fetch(`${BASE_URL}/api/shouldStop?jobId=${encodeURIComponent(message.jobId)}`)
      .then((r) => r.json())
      .then((data) => sendResponse({ stop: !!data.stop }))
      .catch(() => sendResponse({ stop: false }));
    return true;
  }

  if (message.type === 'PROGRESS') {
    postJSON('/api/progress', message.payload);
    return;
  }

  if (message.type === 'STATUS') {
    postJSON('/api/status', message.payload);
    return;
  }

  if (message.type === 'LOG') {
    postJSON('/api/log', message.payload);
    return;
  }

  if (message.type === 'COMPLETE') {
    postJSON('/api/complete', message.payload);
    return;
  }

  if (message.type === 'SCREENSHOT_REQUEST') {
    const tabId = sender.tab ? sender.tab.id : activeTabId;
    chrome.tabs.get(tabId, (tab) => {
      if (!tab) return sendResponse({ ok: false });
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
        postJSON('/api/screenshot', { asin: message.asin, dataUrl });
        sendResponse({ ok: true });
      });
    });
    return true;
  }
});

pollLoop();
