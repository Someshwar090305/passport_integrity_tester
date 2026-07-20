import {
  parseMrzLine1,
  parseMrzLine2,
  validateMrzChecksums,
  validateMrzCompositeCheck
} from './mrzChecksum.js';
import { validateVisualMrzDobMatch } from './visualCrosscheck.js';
import { pick, yyMmDdToIso, cleanMrzLine } from '../utils/helpers.js';

function normalizePassportNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function normalizeDateForCompare(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const [dd, mm, yyyy] = str.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{6}$/.test(str)) {
    const yy = Number(str.slice(0, 2));
    const mm = str.slice(2, 4);
    const dd = str.slice(4, 6);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return `${year}-${mm}-${dd}`;
  }
  return null;
}

function datesMatch(left, right) {
  const a = normalizeDateForCompare(left);
  const b = normalizeDateForCompare(right);
  if (!a || !b) return null;
  return a === b;
}

function passportNumbersMatch(mrzPassport, visualPassport) {
  const mrz = normalizePassportNumber(mrzPassport);
  const visual = normalizePassportNumber(visualPassport);
  if (!mrz || !visual) return null;
  if (mrz === visual) return true;
  // Allow at most 1 trailing character of OCR truncation, but only when
  // the shorter value is already >= 7 chars (prevents short strings from
  // accidentally matching longer unrelated numbers).
  const shorter = mrz.length <= visual.length ? mrz : visual;
  const longer = mrz.length <= visual.length ? visual : mrz;
  if (longer.length - shorter.length === 1 && shorter.length >= 7 && longer.startsWith(shorter)) {
    return true;
  }
  return false;
}

export function runMrzIntegrityChecks(ocr, parsedMrz, mrzChecksumResult) {
  let mrzLine1 = pick(ocr?.mrz?.line1, ocr?.front?.mrz_line1, ocr?.mrz_line1, '');
  let mrzLine2 = pick(ocr?.mrz?.line2, ocr?.front?.mrz_line2, ocr?.mrz_line2, '');

  // Mirror the swap-detection from validationEngine.js.
  // This function re-reads the raw lines independently to drive parsedLine1 and
  // validateMrzCompositeCheck, so the swap must be applied here too.
  const _l1 = String(mrzLine1).replace(/[^A-Z0-9<]/gi, '').toUpperCase();
  const _l2 = String(mrzLine2).replace(/[^A-Z0-9<]/gi, '').toUpperCase();
  if (_l2.startsWith('P<') && !_l1.startsWith('P<')) {
    [mrzLine1, mrzLine2] = [mrzLine2, mrzLine1];
  }

  const parsedLine1 = parseMrzLine1(mrzLine1);
  const parsedLine2 = parsedMrz || parseMrzLine2(mrzLine2);
  const compositeResult = validateMrzCompositeCheck(mrzLine2);

  // Use the MRZ-free visual_raw values for cross-checks when available.
  // visual_raw is populated by googleVisionClient.js and contains only what
  // OCR can read on the printed page — never overwritten by MRZ data.
  //
  // If visual_raw is present but a field is null, OCR genuinely could not
  // read it. We must NOT fall back to the MRZ-assisted front.* value here,
  // or the cross-check becomes circular (MRZ compared against itself).
  //
  // If visual_raw is absent (legacy test callers / direct unit tests that
  // pass hand-crafted ocr objects), fall back to the old pick() chain so
  // existing tests keep passing without modification.
  const hasVisualRaw = ocr?.front?.visual_raw !== undefined;

  const visualPassport = hasVisualRaw
    ? (ocr.front.visual_raw.passport_number ?? null)
    : pick(ocr?.front?.passport_number, ocr?.passport_number, null);

  const visualDob = hasVisualRaw
    ? (ocr.front.visual_raw.date_of_birth ?? null)
    : pick(ocr?.front?.date_of_birth, ocr?.date_of_birth, ocr?.visual?.date_of_birth, null);

  const visualExpiry = hasVisualRaw
    ? (ocr.front.visual_raw.expiry_date ?? null)
    : pick(ocr?.front?.expiry_date, ocr?.expiry_date, null);

  const mrzPassport = parsedLine2?.passportNumber || null;
  const mrzExpiryIso = yyMmDdToIso(parsedLine2?.expiryDateRaw || '');

  const passportMatch = passportNumbersMatch(mrzPassport, visualPassport);
  const dobMatch =
    visualDob === null || visualDob === undefined
      ? null
      : validateVisualMrzDobMatch(parsedLine2?.dateOfBirthRaw, visualDob);
  const expiryMatch = datesMatch(mrzExpiryIso, visualExpiry);

  const issuingCountry = parsedLine1?.issuingCountry || parsedLine2?.nationality || null;
  // Only penalise when the OCR produced a well-formed 3-uppercase-letter ICAO
  // country code that is positively not IND. Single-char garbage ('Y'), mixed
  // values ('1IN'), or filler ('<<<') are OCR noise — treat them as unreadable
  // rather than a confirmed foreign nationality, avoiding a false 10-pt deduction.
  const isCleanCode = issuingCountry !== null && /^[A-Z]{3}$/.test(issuingCountry);
  const countryValid = !isCleanCode || issuingCountry === 'IND';

  return {
    mrz_line1_parse_valid: Boolean(parsedLine1),
    mrz_composite_check_valid: compositeResult.applicable ? compositeResult.valid : true,
    mrz_composite_check_applicable: compositeResult.applicable,
    mrz_country_valid: countryValid,
    // null means one or both passport numbers were absent from OCR.
    // Return false so a missing visual number is not mistaken for a confirmed
    // match — the scoring layer will gate this via visual_passport_present.
    mrz_visual_passport_match: passportMatch === null ? false : passportMatch,
    mrz_visual_dob_match: dobMatch === null ? false : dobMatch,
    mrz_visual_expiry_match: expiryMatch === null ? true : expiryMatch,
    mrz_checksums_valid: mrzChecksumResult.valid,
    visual_dob_present: visualDob !== null && visualDob !== undefined,
    visual_passport_present: Boolean(visualPassport),
    mrz_passport_present: Boolean(mrzPassport),
    details: {
      mrz_line1: parsedLine1,
      mrz_line2: mrzLine2 || null,
      passport_match: passportMatch,
      dob_match: dobMatch,
      expiry_match: expiryMatch,
      issuing_country: issuingCountry
    }
  };
}
