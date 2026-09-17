'use strict';

const XLSX = require('xlsx');
const { validateRecords } = require('../utils/validation');

/**
 * Reads an .xlsx file from disk and returns validated records.
 * Throws only on unreadable/corrupt files — business validation
 * errors are returned in the result object, not thrown.
 */
function readExcelFile(filePath) {
  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (err) {
    throw new Error(`Unable to read Excel file: ${err.message}`);
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('The Excel file contains no sheets.');
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (rawRows.length === 0) {
    return { valid: false, records: [], errors: ['The Excel file has no data rows.'], uniqueAsinCount: 0 };
  }

  return validateRecords(rawRows);
}

module.exports = { readExcelFile };
