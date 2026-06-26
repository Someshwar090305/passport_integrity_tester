/**
 * Returns the first defined, non-null, non-empty-string value from the arguments.
 * Used throughout the codebase to pick the best available OCR field.
 *
 * @param {...*} values
 * @returns {*}
 */
export function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

/**
 * Converts a 6-digit YYMMDD string (as found in MRZ fields) to an ISO date string.
 * Years 50-99 are treated as 1950-1999; 00-49 as 2000-2049.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function yyMmDdToIso(value) {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = value.slice(2, 4);
  const dd = value.slice(4, 6);
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
}

/**
 * Strips all characters that are not valid MRZ characters (A-Z, 0-9, <),
 * upper-cases, and trims the result.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanMrzLine(raw) {
  return String(raw || '').replace(/[^A-Z0-9<]/gi, '').toUpperCase().trim();
}

/**
 * Normalises a date string from various OCR/LLM formats to ISO 8601 (YYYY-MM-DD).
 * Handles:
 *   - Already-ISO strings
 *   - Embedded ISO substrings (e.g. "DOB: 1990-01-15")
 *   - DD/MM/YYYY and DD-MM-YYYY
 *   - 6-digit YYMMDD (MRZ format)
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
export function normalizeDateString(raw) {
  if (!raw) return null;
  const value = String(raw).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const isoMatch = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const dmyMatch = value.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/);
  if (dmyMatch) {
    const dd = dmyMatch[1].padStart(2, '0');
    const mm = dmyMatch[2].padStart(2, '0');
    const yyyy = dmyMatch[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  const yymmddMatch = value.match(/\b(\d{6})\b/);
  if (yymmddMatch) {
    const yy = Number(yymmddMatch[1].slice(0, 2));
    const mm = yymmddMatch[1].slice(2, 4);
    const dd = yymmddMatch[1].slice(4, 6);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return `${year}-${mm}-${dd}`;
  }

  return null;
}
