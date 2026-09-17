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

// Amazon's inputs are React-controlled — a plain `el.value = x` is ignored
// by React's state, so we go through the native setter React itself
// overrides, then fire the events React listens for.
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc.set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findButtonByText(text) {
  const candidates = document.querySelectorAll('button, a[role="button"], input[type="button"], input[type="submit"]');
  const target = text.toLowerCase();
  for (const el of candidates) {
    const label = (el.innerText || el.value || '').trim().toLowerCase();
    if (label.includes(target)) return el;
  }
  return null;
}

// The button's visible text differs between known page variants ("Add
// Item" vs "Add to order") but its test-id/id/class is stable within
// each variant, so match on that first and only fall back to guessing
// at text if a future variant doesn't match either known selector.
function findAddItemButton() {
  return (
    document.querySelector(SELECTORS.addItemButton) ||
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
  if (document.querySelector(SELECTORS.asinInput)) return; // already on the add-item form

  const btn = findButtonByText('Create bulk order') || findButtonByText('Start a quote');
  if (btn) {
    const label = (btn.innerText || btn.value || '').trim();
    btn.click();
    sendLog(`Clicked "${label}"`);
    try {
      await waitFor(() => document.querySelector(SELECTORS.asinInput), { timeout: 15000 });
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
  if (document.querySelector(SELECTORS.asinInput)) return;

  const tabBtn = document.querySelector(SELECTORS.inputTypeTab) || findButtonByText('ASIN or ISBN');
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
        await waitFor(() => document.querySelector(SELECTORS.asinInput), { timeout: 15000 });
      } catch {
        // addSingleItem's own waitFor will report the real error if the form still isn't there
      }
    }
    return;
  }

  const dropdownToggle = document.querySelector(SELECTORS.inputTypeDropdownToggle);
  if (dropdownToggle) {
    // Same reasoning as above: this dropdown usually already shows "ASIN
    // or ISBN" as the current selection by default — only open and pick
    // it if it doesn't.
    if (!/asin\s*or\s*isbn/i.test(dropdownToggle.innerText || '')) {
      dropdownToggle.click();
      await sleep(300);
      const option = document.querySelector(SELECTORS.inputTypeDropdownIsbnOption);
      if (option) {
        option.click();
        sendLog('Selected "ASIN or ISBN" input mode (dropdown)');
        try {
          await waitFor(() => document.querySelector(SELECTORS.asinInput), { timeout: 15000 });
        } catch {
          // addSingleItem's own waitFor will report the real error if the form still isn't there
        }
      }
    }
  }
}

async function addSingleItem(asin, quantity, actionTimeoutMs) {
  const countBefore = getItemsCount() ?? 0;
  sendLog(`[diag] countBefore=${countBefore}`);

  const asinField = await waitFor(() => document.querySelector(SELECTORS.asinInput), { timeout: actionTimeoutMs });
  sendLog(`[diag] found ASIN field: id="${asinField.id}"`);
  asinField.focus();
  setNativeValue(asinField, '');
  setNativeValue(asinField, asin);
  sendLog(`[diag] ASIN field value after set: "${asinField.value}"`);

  // Amazon likely does an async lookup/validation of the ASIN after it's
  // typed before "Add Item" is actually functional — give it a moment
  // instead of clicking Add Item almost instantly.
  await sleep(1500);

  const qtyField = await waitFor(() => document.querySelector(SELECTORS.quantityInput), { timeout: actionTimeoutMs });
  sendLog(`[diag] found Quantity field: id="${qtyField.id}"`);
  qtyField.focus();
  setNativeValue(qtyField, '');
  setNativeValue(qtyField, String(quantity));
  sendLog(`[diag] Quantity field value after set: "${qtyField.value}"`);

  const addBtn = await waitFor(() => findAddItemButton(), { timeout: actionTimeoutMs });
  sendLog(
    `[diag] found Add button: id="${addBtn.id}" text="${(addBtn.innerText || addBtn.value || '').trim()}" disabled=${addBtn.disabled} aria-disabled=${addBtn.getAttribute('aria-disabled')}`
  );
  addBtn.click();
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
