'use strict';

const MAX_ASINS = 49;

/**
 * Normalizes a raw row object (arbitrary-cased keys) into { asin, quantity }.
 * Accepts ASIN / asin / Asin and Quantity / quantity / QTY / qty.
 */
function normalizeRow(rawRow) {
  const keys = Object.keys(rawRow);
  const asinKey = keys.find((k) => k.trim().toLowerCase() === 'asin');
  const qtyKey = keys.find((k) => {
    const norm = k.trim().toLowerCase();
    return norm === 'quantity' || norm === 'qty';
  });

  const asinRaw = asinKey ? rawRow[asinKey] : undefined;
  const qtyRaw = qtyKey ? rawRow[qtyKey] : undefined;

  return {
    asin: typeof asinRaw === 'string' ? asinRaw.trim() : asinRaw != null ? String(asinRaw).trim() : '',
    quantityRaw: qtyRaw,
  };
}

/**
 * Validates the full parsed record set.
 * Returns { valid: boolean, records: [{asin, quantity, rowNumber}], errors: [string] }
 * Does NOT silently merge or drop duplicates — a duplicate is a hard error.
 */
function validateRecords(rawRows) {
  const errors = [];
  const records = [];
  const seenAsins = new Map(); // asin -> [rowNumbers]

  rawRows.forEach((rawRow, idx) => {
    const rowNumber = idx + 2; // +2 accounts for header row + 1-indexing
    const { asin, quantityRaw } = normalizeRow(rawRow);

    if (!asin) {
      errors.push(`Row ${rowNumber}: ASIN is empty.`);
      return;
    }

    if (quantityRaw === undefined || quantityRaw === null || quantityRaw === '') {
      errors.push(`Row ${rowNumber}: Quantity is empty for ASIN ${asin}.`);
      return;
    }

    const quantity = Number(quantityRaw);
    if (Number.isNaN(quantity)) {
      errors.push(`Row ${rowNumber}: Quantity "${quantityRaw}" is not numeric for ASIN ${asin}.`);
      return;
    }

    if (quantity <= 0) {
      errors.push(`Row ${rowNumber}: Quantity must be greater than 0 for ASIN ${asin}.`);
      return;
    }

    if (!seenAsins.has(asin)) {
      seenAsins.set(asin, []);
    }
    seenAsins.get(asin).push(rowNumber);

    records.push({ asin, quantity, rowNumber, status: 'PENDING' });
  });

  // Duplicate detection — reported explicitly, never auto-merged.
  for (const [asin, rows] of seenAsins.entries()) {
    if (rows.length > 1) {
      errors.push(`Duplicate ASIN "${asin}" found in rows: ${rows.join(', ')}.`);
    }
  }

  const uniqueAsinCount = seenAsins.size;
  if (uniqueAsinCount > MAX_ASINS) {
    errors.push(`Too many unique ASINs: ${uniqueAsinCount} found, maximum allowed is ${MAX_ASINS}.`);
  }

  return {
    valid: errors.length === 0,
    records,
    errors,
    uniqueAsinCount,
  };
}

module.exports = { validateRecords, normalizeRow, MAX_ASINS };
