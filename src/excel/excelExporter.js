'use strict';

const XLSX = require('xlsx');

/**
 * Writes ONLY successful items to an .xlsx file at the given path.
 * successfulItems: [{ asin, quantity }]
 */
function exportSuccessfulItems(successfulItems, destPath) {
  const rows = successfulItems.map((item) => ({
    ASIN: item.asin,
    Quantity: item.quantity,
  }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Successful Items');
  XLSX.writeFile(workbook, destPath);

  return destPath;
}

module.exports = { exportSuccessfulItems };
