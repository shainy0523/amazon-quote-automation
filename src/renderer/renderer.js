'use strict';

const selectExcelBtn = document.getElementById('selectExcelBtn');
const selectedFileEl = document.getElementById('selectedFile');
const totalRecordsEl = document.getElementById('totalRecords');
const validationErrorsEl = document.getElementById('validationErrors');
const previewTableBody = document.querySelector('#previewTable tbody');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const progressText = document.getElementById('progressText');
const currentAsinEl = document.getElementById('currentAsin');
const currentQtyEl = document.getElementById('currentQty');
const currentStatusEl = document.getElementById('currentStatus');
const progressBarFill = document.getElementById('progressBarFill');
const completionPanel = document.getElementById('completionPanel');
const finalTotalEl = document.getElementById('finalTotal');
const finalSuccessEl = document.getElementById('finalSuccess');
const finalFailedEl = document.getElementById('finalFailed');
const downloadBtn = document.getElementById('downloadBtn');
const logPanel = document.getElementById('logPanel');

let currentRecords = [];

function renderPreview(records) {
  previewTableBody.innerHTML = '';
  records.forEach((rec, idx) => {
    const tr = document.createElement('tr');
    tr.id = `row-${rec.asin}`;
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${rec.asin}</td>
      <td>${rec.quantity}</td>
      <td class="status-${rec.status}">${rec.status}</td>
    `;
    previewTableBody.appendChild(tr);
  });
}

function updateRowStatus(asin, status) {
  const row = document.getElementById(`row-${asin}`);
  if (!row) return;
  const statusCell = row.querySelector('td:last-child');
  statusCell.textContent = status;
  statusCell.className = `status-${status}`;
}

selectExcelBtn.addEventListener('click', async () => {
  const result = await window.amazonAutomation.selectExcel();
  if (result.canceled) return;

  selectedFileEl.textContent = result.filePath;

  const preview = await window.amazonAutomation.previewExcel();
  validationErrorsEl.classList.add('hidden');
  validationErrorsEl.innerHTML = '';

  if (!preview.valid) {
    validationErrorsEl.classList.remove('hidden');
    validationErrorsEl.innerHTML = `<strong>Validation errors:</strong><ul>${preview.errors
      .map((e) => `<li>${e}</li>`)
      .join('')}</ul>`;
    startBtn.disabled = true;
    currentRecords = [];
    totalRecordsEl.textContent = '0';
    previewTableBody.innerHTML = '';
    return;
  }

  currentRecords = preview.records;
  totalRecordsEl.textContent = String(currentRecords.length);
  renderPreview(currentRecords);
  startBtn.disabled = false;
});

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  completionPanel.classList.add('hidden');
  const browserTarget = document.querySelector('input[name="browserTarget"]:checked').value;
  const result = await window.amazonAutomation.start(browserTarget);
  if (!result.started) {
    currentStatusEl.textContent = `Status: Error — ${result.error}`;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', async () => {
  await window.amazonAutomation.stop();
  stopBtn.disabled = true;
});

downloadBtn.addEventListener('click', async () => {
  const result = await window.amazonAutomation.downloadSuccessfulItems();
  if (result.saved) {
    currentStatusEl.textContent = `Status: Saved to ${result.filePath}`;
  } else if (result.error) {
    currentStatusEl.textContent = `Status: Export error — ${result.error}`;
  }
});

window.amazonAutomation.onProgress((data) => {
  const { current, total, asin, quantity, status, error } = data;
  progressText.textContent = `Processing ${current} / ${total}`;
  currentAsinEl.textContent = `Current ASIN: ${asin}`;
  currentQtyEl.textContent = `Quantity: ${quantity}`;
  currentStatusEl.textContent = `Status: ${status === 'PROCESSING' ? 'Adding item...' : status}${
    error ? ` (${error})` : ''
  }`;
  progressBarFill.style.width = `${Math.round((current / total) * 100)}%`;
  updateRowStatus(asin, status);
});

window.amazonAutomation.onLog((line) => {
  logPanel.textContent += line + '\n';
  logPanel.scrollTop = logPanel.scrollHeight;
});

window.amazonAutomation.onStatus((data) => {
  const { state, total, successful, failed, error } = data;

  if (state === 'WAITING_FOR_EXTENSION') {
    currentStatusEl.textContent =
      'Status: Waiting for the browser extension to pick up the job — make sure it is installed and Chrome is open.';
  } else if (state === 'AUTH_CHECK') {
    currentStatusEl.textContent = 'Status: Checking Amazon session...';
  } else if (state === 'LOGIN_REQUIRED') {
    currentStatusEl.textContent =
      'Status: Amazon login required. Please log in in the browser window, then wait — automation continues automatically once detected.';
  } else if (state === 'CHALLENGE') {
    currentStatusEl.textContent = 'Status: Security check (MFA/CAPTCHA) — please complete it in the browser window.';
  } else if (state === 'AUTHENTICATED' || state === 'PROCESSING') {
    currentStatusEl.textContent = 'Status: Processing...';
  } else if (state === 'COMPLETED' || state === 'STOPPED') {
    completionPanel.classList.remove('hidden');
    finalTotalEl.textContent = String(total);
    finalSuccessEl.textContent = String(successful);
    finalFailedEl.textContent = String(failed);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    currentStatusEl.textContent =
      state === 'COMPLETED'
        ? 'Status: All items processed. Please review the Amazon page manually.'
        : 'Status: Stopped by user.';
  } else if (state === 'ERROR') {
    currentStatusEl.textContent = `Status: Automation error — ${error}`;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});
