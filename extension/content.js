'use strict';

// Runs directly inside the user's real Amazon tab — no separate browser,
// no separate profile, same session.
//
// Amazon's own `test-id`/`testid` attributes are the most stable hooks
// available (they're React component test hooks, not auto-generated
// styling classes/ids that churn on every redesign), so selectors prefer
// those first. Amazon Business has shown at least two different layouts
// for this same "add item" flow so far — each selector below lists every
// known variant, broadest/most specific first, so this keeps working if
// Amazon switches which one it shows without needing a code change:
//   - current "New bulk order" page: input#input-form-isbn-input,
//     input#input-form-quantity-input, button#spot_buy_input_add_item_button
//   - older tab-based page: input#add-asin-or-isbn-form, input#item-quantity,
//     button#add-item-btn (text "Add Item")
// If Amazon changes markup again, add the new variant's test-id/id here
// rather than replacing what's already listed.
const SELECTORS = {
  asinInput:
    'input[testid*="isbn" i], input[id*="isbn" i], ' +
    'input[aria-describedby*="ASIN" i], input[aria-label*="ASIN" i], ' +
    'input[name*="asin" i], input[id*="asin" i]',
  quantityInput:
    'input[testid*="quantity" i], input[id*="quantity" i], ' +
    'input[aria-describedby*="Quantity" i], input[aria-label*="Quantity" i], ' +
    'input[name*="quantity" i]',
  addItemButton:
    'button[test-id*="add_item" i], button[testid*="add_item" i], ' +
    'button.add-item-button, #add-item-btn, #spot_buy_input_add_item_button',
  inputTypeTab: '#input-type-ISBN', // older page's tab button for "ASIN or ISBN"
  inputTypeDropdownToggle: '#input-type-dropdown', // current page's dropdown toggle
  inputTypeDropdownIsbnOption: '[test-id="drop-down-option-ISBN"]',
  errorMessage: '[role="alert"], .a-alert-error, .a-alert-content',
  loginIndicator: 'input#ap_email, form[name="signIn"]',
  challengeIndicator: 'form[action*="verify" i], img[src*="captcha" i], #auth-mfa-form',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(conditionFn, { timeout = 15000, interval = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      let result;
      try {
        result = conditionFn();
      } catch {
        result = null;
      }
      if (result) return resolve(result);
      if (Date.now() - start > timeout) return reject(new Error('Timed out waiting for condition'));
      setTimeout(check, interval);
    };
    check();
  });
}

// Content scripts run in their own isolated JS realm, separate from the
// page's — objects built from this script's own `window`/`Event`/
// `KeyboardEvent` are a different realm than what the page's React app
// expects, which has been observed to make typing silently stall
// mid-keystroke on Amazon's page (a plain page-console test with the same
// logic, using the page's own realm, ran to completion without issue).
// Using the page's actual window for every constructor avoids that gap.
function pageWindow(el) {
  return el.ownerDocument.defaultView || window;
}

// Amazon's inputs are React-controlled — a plain `el.value = x` is ignored
// by React's state, so we go through the native setter React itself
// overrides, then fire the events React listens for.
function setNativeValue(el, value, { fireChange = true } = {}) {
  const win = pageWindow(el);
  const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc.set.call(el, value);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  if (fireChange) el.dispatchEvent(new win.Event('change', { bubbles: true }));
}

// A single bulk setNativeValue + one input/change event doesn't look like
// real typing to a form that runs per-keystroke validation — Amazon
// Business's ASIN field appears to be one of these (setting it in bulk
// preceded a full page reload that killed the running script mid-job).
// Simulating individual keystrokes (key events + incremental value commits,
// 'change'/'blur' only at the end) matches what real typing produces.
//
// This has been observed to silently hang mid-loop on Amazon's page with
// no exception and no page navigation — cause not yet root-caused, and it
// reproduced even after switching to the page's own realm for every
// constructed event, so it isn't a content-script/page realm mismatch
// either. Notably it did NOT reproduce when the identical per-keystroke
// logic was run by hand in the page's console with plain console.log
// instead of chrome.runtime.sendMessage — the one other thing this loop
// does that a plain typing test doesn't. Rather than keep sending a
// cross-process message per keystroke (removed below), progress is
// tracked locally and only reported if the loop actually stalls, so a
// repeat hang still tells us exactly which character it died on without
// that messaging traffic being a variable.
async function typeIntoField(el, value, delayMs = 60) {
  console.log(`[AQA] typeIntoField start, target=#${el.id || '(no id)'}, value="${value}"`);
  const timeoutMs = Math.max(5000, value.length * delayMs * 3 + 3000);
  let charsTyped = 0;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      console.log(`[AQA] typeIntoField TIMED OUT after ${charsTyped}/${value.length} chars`);
      reject(
        new Error(
          `Typing into #${el.id || '(no id)'} stalled after ${charsTyped}/${value.length} characters ` +
            `("${value.slice(0, charsTyped)}") — timed out after ${timeoutMs}ms`
        )
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([typeCharsInto(el, value, delayMs, () => charsTyped++), timeout]);
    console.log(`[AQA] typeIntoField done, final value="${el.value}"`);
  } finally {
    clearTimeout(timer);
  }
}

async function typeCharsInto(el, value, delayMs, onCharTyped) {
  const win = pageWindow(el);
  setNativeValue(el, '', { fireChange: false });
  let current = '';
  for (const char of value) {
    current += char;
    console.log(`[AQA] about to dispatch keydown for "${char}"`);
    el.dispatchEvent(new win.KeyboardEvent('keydown', { key: char, bubbles: true }));
    el.dispatchEvent(new win.KeyboardEvent('keypress', { key: char, bubbles: true }));
    setNativeValue(el, current, { fireChange: false });
    el.dispatchEvent(new win.KeyboardEvent('keyup', { key: char, bubbles: true }));
    console.log(`[AQA] finished char "${char}", value now="${el.value}"`);
    onCharTyped();
    await sleep(delayMs);
    console.log(`[AQA] woke up from sleep after "${char}"`);
  }
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  el.dispatchEvent(new win.Event('blur', { bubbles: true }));
}

// Amazon's SPA has been observed leaving a previous layout's markup
// sitting hidden in the DOM after switching to another (e.g. the
// dropdown-based layout's "add-item" button stays present-but-hidden
// after the page moves to the tab-based layout, or vice versa). A broad
// attribute selector's querySelector() returns the first DOM match
// regardless of visibility, so it can silently grab a stale hidden
// element from a layout that's no longer actually active — clicking it
// does nothing real, which reproduced as a reliable, layout-specific
// failure. Every interactive-element lookup below filters to visible
// matches first, only falling back to an invisible one if truly nothing
// visible matches (better than finding nothing at all).
function isVisible(el) {
  return !!(el && el.offsetParent !== null && el.getClientRects().length > 0);
}

function firstVisible(selector) {
  const matches = document.querySelectorAll(selector);
  for (const el of matches) {
    if (isVisible(el)) return el;
  }
  return matches[0] || null;
}

// Amazon's id/testid attributes are auto-generated by their React build
// and can change on redeploys, silently breaking the attribute-based
// SELECTORS above. Label text is user-facing copy, not a build artifact,
// so it's a much more stable fallback: find the <label> mentioning e.g.
// "ASIN" or "Quantity", then resolve it to its input via `for`, DOM
// nesting, or shared form-group container (all three are used across
// Amazon's known layouts).
function findByLabelText(labelText) {
  const target = labelText.toLowerCase();
  const labels = document.querySelectorAll('label, legend, [role="group"] span');
  for (const label of labels) {
    const text = (label.textContent || '').trim().toLowerCase();
    if (!text.includes(target)) continue;

    const forId = label.getAttribute('for');
    if (forId) {
      const input = document.getElementById(forId);
      if (input) return input;
    }

    const nested = label.querySelector('input');
    if (nested) return nested;

    const group = label.closest('fieldset, .b-form-group, [class*="form-group" i]') || label.parentElement;
    const input = group && group.querySelector('input');
    if (input) return input;
  }
  return null;
}

function findAsinInput() {
  return firstVisible(SELECTORS.asinInput) || findByLabelText('asin') || findByLabelText('isbn');
}

function findQuantityInput() {
  return firstVisible(SELECTORS.quantityInput) || findByLabelText('quantity');
}

function findButtonByText(text) {
  const candidates = document.querySelectorAll('button, a[role="button"], input[type="button"], input[type="submit"]');
  const target = text.toLowerCase();
  let firstMatch = null;
  for (const el of candidates) {
    const label = (el.innerText || el.value || '').trim().toLowerCase();
    if (!label.includes(target)) continue;
    if (isVisible(el)) return el;
    if (!firstMatch) firstMatch = el;
  }
  return firstMatch;
}

// The button's visible text differs between known page variants ("Add
// Item" vs "Add to order") but its test-id/id/class is stable within
// each variant, so match on that first and only fall back to guessing
// at text if a future variant doesn't match either known selector.
function findAddItemButton() {
  return (
    firstVisible(SELECTORS.addItemButton) ||
    findButtonByText('Add to order') ||
    findButtonByText('Add Item')
  );
}

function detectAuthState() {
  if (document.querySelector(SELECTORS.challengeIndicator)) return 'CHALLENGE';
  if (document.querySelector(SELECTORS.loginIndicator)) return 'LOGIN_REQUIRED';
  return 'AUTHENTICATED';
}

async function waitForManualAuthentication(onStatus, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < timeoutMs) {
    const state = detectAuthState();
    if (state !== lastState) {
      lastState = state;
      onStatus(state);
    }
    if (state === 'AUTHENTICATED') return true;
    await sleep(2000);
  }
  throw new Error('Timed out waiting for manual Amazon login/verification.');
}

function getItemsCount() {
  // Confirmed real indicator on the "New bulk order" page
  // (bulk-order/input): once at least one item is added, the page shows
  // "Total: X products and Y units".
  const totalProductsMatch = document.body.innerText.match(/Total:\s*(\d+)\s*products?/i);
  if (totalProductsMatch) return parseInt(totalProductsMatch[1], 10);

  // Other known page variant: rows with a "Manage item" link.
  const manageItemCount = [...document.querySelectorAll('button, a')].filter(
    (el) => (el.innerText || '').trim().toLowerCase() === 'manage item'
  ).length;
  if (manageItemCount > 0) return manageItemCount;

  const totalItemsMatch = document.body.innerText.match(/Total:\s*(\d+)\s*items?/i);
  return totalItemsMatch ? parseInt(totalItemsMatch[1], 10) : null;
}

async function startQuoteIfNeeded() {
  if (findAsinInput()) return; // already on the add-item form

  const btn = findButtonByText('Create bulk order') || findButtonByText('Start a quote');
  if (btn) {
    const label = (btn.innerText || btn.value || '').trim();
    btn.click();
    sendLog(`Clicked "${label}"`);
    try {
      await waitFor(() => findAsinInput(), { timeout: 15000 });
    } catch {
      // fall through — selectAsinInputModeIfNeeded or addSingleItem's own
      // waitFor will report the real error if the form still isn't there
    }
  }
}

// The bulk-order/input page needs "ASIN or ISBN" input mode selected
// before its ASIN field even exists in the DOM — a fresh landing on that
// page shows "No products added yet. Select the option you want to use
// above" instead of the form. Amazon has shown two different UIs for
// this so far: a row of tab buttons, or a dropdown — handle both.
async function selectAsinInputModeIfNeeded() {
  if (findAsinInput()) return;

  const tabBtn = firstVisible(SELECTORS.inputTypeTab) || findButtonByText('ASIN or ISBN');
  if (tabBtn) {
    // This is a type="submit" tab button that's often already the
    // active/selected tab by default (aria-pressed="true"). Clicking an
    // already-active submit button can trigger a real form submission
    // instead of a harmless no-op toggle, reloading the page and
    // silently killing this whole running script. Only click it when
    // it's not already selected.
    if (tabBtn.getAttribute('aria-pressed') !== 'true') {
      tabBtn.click();
      sendLog('Selected "ASIN or ISBN" input mode (tab)');
      try {
        await waitFor(() => findAsinInput(), { timeout: 15000 });
      } catch {
        // addSingleItem's own waitFor will report the real error if the form still isn't there
      }
    }
    return;
  }

  const dropdownToggle = firstVisible(SELECTORS.inputTypeDropdownToggle);
  if (dropdownToggle) {
    // Same reasoning as above: this dropdown usually already shows "ASIN
    // or ISBN" as the current selection by default — only open and pick
    // it if it doesn't.
    if (!/asin\s*or\s*isbn/i.test(dropdownToggle.innerText || '')) {
      dropdownToggle.click();
      await sleep(300);
      const option = firstVisible(SELECTORS.inputTypeDropdownIsbnOption);
      if (option) {
        option.click();
        sendLog('Selected "ASIN or ISBN" input mode (dropdown)');
        try {
          await waitFor(() => findAsinInput(), { timeout: 15000 });
        } catch {
          // addSingleItem's own waitFor will report the real error if the form still isn't there
        }
      }
    }
  }
}

// The "Add Item" button is type="submit". A real user click normally gets
// intercepted by Amazon's own JS (preventDefault) before the browser's
// native form-submit fires. A programmatic .click() produces a
// non-trusted event, which has been observed to occasionally NOT get
// intercepted the same way — letting the native submit through and
// navigating the whole tab away instead of doing the SPA's AJAX add
// (confirmed: happened on one page layout, not another, so it's
// layout-dependent and will recur intermittently across a large batch).
// A capturing listener that calls preventDefault() first guarantees the
// native submit never fires, regardless of what Amazon's own handler
// does, while leaving every other click handler (which is what actually
// performs the add) completely unaffected.
function clickWithoutNativeSubmit(btn) {
  const suppressSubmit = (e) => e.preventDefault();
  btn.addEventListener('click', suppressSubmit, { capture: true });
  try {
    btn.click();
  } finally {
    btn.removeEventListener('click', suppressSubmit, { capture: true });
  }
}

async function addSingleItem(asin, quantity, actionTimeoutMs) {
  // Re-verify we're actually still on a live add-item form before every
  // single item, not just once at the start of the whole batch — over a
  // 20+ item run, anything that resets the page mid-batch (the native
  // submit navigation above, or Amazon re-rendering) would otherwise
  // silently break every item after that point.
  await startQuoteIfNeeded();
  await selectAsinInputModeIfNeeded();

  const countBefore = getItemsCount() ?? 0;
  sendLog(`[diag] countBefore=${countBefore}`);

  const asinField = await waitFor(() => findAsinInput(), { timeout: actionTimeoutMs });
  sendLog(`[diag] found ASIN field: id="${asinField.id}"`);
  asinField.focus();
  await typeIntoField(asinField, asin);
  sendLog(`[diag] ASIN field value after set: "${asinField.value}"`);

  // Amazon likely does an async lookup/validation of the ASIN after it's
  // typed before "Add Item" is actually functional — give it a moment
  // instead of clicking Add Item almost instantly.
  await sleep(1500);

  const qtyField = await waitFor(() => findQuantityInput(), { timeout: actionTimeoutMs });
  sendLog(`[diag] found Quantity field: id="${qtyField.id}"`);
  qtyField.focus();
  await typeIntoField(qtyField, String(quantity));
  sendLog(`[diag] Quantity field value after set: "${qtyField.value}"`);

  const addBtn = await waitFor(() => findAddItemButton(), { timeout: actionTimeoutMs });
  sendLog(
    `[diag] found Add button: id="${addBtn.id}" text="${(addBtn.innerText || addBtn.value || '').trim()}" disabled=${addBtn.disabled} aria-disabled=${addBtn.getAttribute('aria-disabled')}`
  );
  clickWithoutNativeSubmit(addBtn);
  sendLog('[diag] clicked Add button');

  try {
    await waitFor(
      () => {
        const count = getItemsCount();
        return count !== null && count > countBefore ? true : null;
      },
      { timeout: actionTimeoutMs, interval: 300 }
    );
    sendLog(`[diag] countAfter=${getItemsCount()} — success detected`);
    return true;
  } catch {
    sendLog(`[diag] countAfter=${getItemsCount()} — no increase detected, page text sample: "${document.body.innerText.slice(0, 300).replace(/\s+/g, ' ')}"`);
    const errorEl = document.querySelector(SELECTORS.errorMessage);
    if (errorEl) {
      throw new Error(`Amazon reported an error: ${errorEl.textContent.trim()}`);
    }
    throw new Error('Item count did not increase after Add Item within the timeout.');
  }
}

function sendMessage(type, payload) {
  chrome.runtime.sendMessage({ type, payload });
}
function sendProgress(payload) {
  sendMessage('PROGRESS', payload);
}
function sendStatus(payload) {
  sendMessage('STATUS', payload);
}
function sendLog(line) {
  sendMessage('LOG', { line });
}
function sendComplete(payload) {
  sendMessage('COMPLETE', payload);
}

function checkShouldStop(jobId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SHOULD_STOP', jobId }, (response) => {
      resolve(!!(response && response.stop));
    });
  });
}

function requestScreenshot(asin) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SCREENSHOT_REQUEST', asin }, () => resolve());
  });
}

// The window-focus fix in background.js only raises Firefox to the front
// once, when the job starts. A user checking progress in the desktop app
// mid-batch re-steals OS focus, which can bring back the same throttling-
// caused stall on a later item. Pinging this before every item keeps the
// browser window in front for the whole batch, not just the first item.
function ensureWindowFocused() {
  chrome.runtime.sendMessage({ type: 'ENSURE_FOCUSED' });
}

async function runJob(job) {
  const { jobId, records, maxRetries = 2, actionTimeoutMs = 15000 } = job;

  sendStatus({ jobId, state: 'AUTH_CHECK' });
  try {
    await waitForManualAuthentication((state) => sendStatus({ jobId, state }));
  } catch (err) {
    sendStatus({ jobId, state: 'ERROR', error: err.message });
    return;
  }

  sendStatus({ jobId, state: 'PROCESSING' });
  await startQuoteIfNeeded();
  await selectAsinInputModeIfNeeded();

  const successfulItems = [];
  const failedItems = [];
  let stopped = false;

  for (let i = 0; i < records.length; i++) {
    if (await checkShouldStop(jobId)) {
      stopped = true;
      sendLog(`Stop requested — halting before record ${i + 1}/${records.length}`);
      break;
    }

    const { asin, quantity } = records[i];
    const current = i + 1;
    sendLog(`Processing ${current}/${records.length}`);
    sendProgress({ jobId, current, total: records.length, asin, quantity, status: 'PROCESSING' });
    ensureWindowFocused();

    let success = false;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries && !success; attempt++) {
      try {
        if (attempt > 0) sendLog(`Retrying ${asin} (attempt ${attempt + 1}/${maxRetries + 1})`);
        success = await addSingleItem(asin, quantity, actionTimeoutMs);
      } catch (err) {
        lastError = err.message;
        sendLog(`Attempt failed for ${asin}: ${err.message}`);
        await requestScreenshot(asin);
      }
    }

    if (success) {
      sendLog(`${asin} successfully added`);
      successfulItems.push({ asin, quantity });
      sendProgress({ jobId, current, total: records.length, asin, quantity, status: 'SUCCESS' });
    } else {
      sendLog(`${asin} failed: ${lastError}`);
      failedItems.push({ asin, quantity, error: lastError || 'Unknown error' });
      sendProgress({ jobId, current, total: records.length, asin, quantity, status: 'FAILED', error: lastError });
    }

    // Amazon appears to reject an Add-Item click that lands too soon after
    // the previous one (observed: a successful add followed 2s later by
    // another click reliably bounced to the homepage and needed a retry,
    // wasting a full actionTimeoutMs on every single item). A fixed pause
    // between items clears that cooldown up front instead of paying for it
    // as a guaranteed-fail-then-retry cycle every time.
    const isLastItem = i === records.length - 1;
    if (!isLastItem) await sleep(4000);
  }

  const finalState = stopped ? 'STOPPED' : 'COMPLETED';
  sendLog(
    finalState === 'COMPLETED'
      ? `Automation completed. Total: ${records.length}, Successful: ${successfulItems.length}, Failed: ${failedItems.length}`
      : `Automation stopped. Processed: ${successfulItems.length + failedItems.length}/${records.length}`
  );
  sendStatus({
    jobId,
    state: finalState,
    total: records.length,
    successful: successfulItems.length,
    failed: failedItems.length,
  });
  sendComplete({ jobId, successfulItems, failedItems, stopped });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'RUN_JOB') {
    runJob(message.job).catch((err) => sendLog(`Unexpected error: ${err.message}`));
    sendResponse({ ok: true });
    return true;
  }
});
