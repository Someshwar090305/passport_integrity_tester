import { yyMmDdToIso, normalizeDateString } from '../utils/helpers.js';

// Uses normalizeDateString from helpers (which handles DD/MM/YYYY, DD-MM-YYYY, and
// embedded ISO substrings) rather than the old private normalizeDate that only
// handled the slash variant. yyMmDdToIso is also imported from helpers,
// eliminating the last duplicate definition in the codebase.

export function validateVisualMrzDobMatch(mrzDobRaw, visualDobRaw) {
  // MRZ DOB is a 6-digit YYMMDD string; visual DOB may be in various formats.
  const mrzDob = yyMmDdToIso(String(mrzDobRaw || '').trim()) ??
                 normalizeDateString(mrzDobRaw);
  const visualDob = normalizeDateString(visualDobRaw);
  if (!mrzDob || !visualDob) return false;
  return mrzDob === visualDob;
}
