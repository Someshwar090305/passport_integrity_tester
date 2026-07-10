import {
  extractRpoCode,
  inferRpoCodeFromAddress,
  parseAddressBlock,
  inferRpoCodeFromCity
} from './rpoMapping.js';
import { parseMrzLine2 } from './mrzChecksum.js';

function normalizePassportNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

/**
 * Compares two passport numbers with the same 1-char OCR-truncation tolerance
 * used by mrzIntegrity.js (passportNumbersMatch).
 * Returns true / false.  Returns null when either value is absent.
 */
function passportNumbersMatch(a, b) {
  const na = normalizePassportNumber(a);
  const nb = normalizePassportNumber(b);
  if (!na || !nb) return null;
  if (na === nb) return true;
  // Allow at most one trailing character of OCR truncation, but only when the
  // shorter string is already ≥ 7 chars so short strings cannot accidentally
  // match unrelated numbers.
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  if (longer.length - shorter.length === 1 && shorter.length >= 7 && longer.startsWith(shorter)) {
    return true;
  }
  return false;
}

/**
 * Runs document-level consistency checks across the front and back pages.
 *
 * ── Passport-number anchor (cross-page) ──────────────────────────────────────
 * The MRZ on the front page is the cryptographically protected ground truth
 * for the passport's identity. The Indian passport back (address) page prints
 * the same passport number as an unlabeled string below the barcode at the top
 * right corner.  Comparing these two values is the definitive front-vs-back
 * identity check.
 *
 * When the back-page passport number is readable → true cross-page check.
 * When it is absent (OCR miss or older passport format) → fall through to
 * the MRZ optional data check.
 *
 * ── MRZ optional data ↔ File Number (cross-page) ────────────────────────────
 * Indian passports encode the numeric portion of the application file number
 * in MRZ line 2 positions 28–41 (the TD3 optional data field).  Example:
 *
 *   MRZ line 2:  C2203304<6IND7410149M34091092076925493724<02
 *                                             ↑↑↑↑↑↑↑↑↑↑↑↑↑
 *                                             optional data = 2076925493724
 *   Back file no: MA2076925493724 → strip "MA" → 2076925493724  ✓
 *
 * This check is checksum-protected (the optional data is covered by the
 * composite check in MRZ line 2) and is therefore the most reliable anchor
 * when the barcode passport number cannot be extracted.
 *
 * ── RPO / Place of Issue / Address mapping (cross-page) ──────────────────────
 * Verify that the Place of Issue on the front page corresponds to the RPO
 * code of the File Number and the Address on the last page.
 *
 * ── RPO consistency (back-page internal) ────────────────────────────────────
 * The file number prefix (RPO code) must correspond to the address region.
 */
export function runDocumentConsistencyChecks(ocr) {
  // ── Passport number sources ─────────────────────────────────────────────────
  const frontVisual = normalizePassportNumber(
    ocr?.front?.passport_number || ocr?.passport_number
  );
  const mrzLine2 = ocr?.front?.mrz_line2 || ocr?.mrz?.line2 || ocr?.mrz_line2 || '';
  const parsedMrz = parseMrzLine2(mrzLine2);
  const frontMrz  = normalizePassportNumber(parsedMrz?.passportNumber);

  // MRZ optional data — numeric portion of the file number (positions 28–41).
  // India uses this field to encode the application file number without the
  // RPO letter prefix.  Strip any remaining filler characters.
  const mrzOptionalData = (parsedMrz?.optionalData || '').replace(/[^0-9]/g, '') || null;

  // Primary cross-page anchor: passport number printed on the back page.
  const backPassport = normalizePassportNumber(ocr?.back?.passport_number);

  // ── Passport consistency check (tiered) ───────────────────────────────────
  let passportConsistent = true;
  let crossPageCheckPerformed = false;
  let fileNumberMrzMatch = null;  // null = not applicable / not attempted

  // File number from back page — needed for Tier 2 check.
  const fileNumber = String(ocr?.back?.file_number || ocr?.file_number || '')
    .toUpperCase()
    .trim();
  // Strip the leading RPO letter prefix to get the numeric serial.
  // e.g. "MA2076925493724" → "2076925493724"
  const fileNumberNumeric = fileNumber.replace(/^[A-Z]+/, '');

  // TIER 1: Back-page passport number vs front MRZ passport number.
  // This is the most direct identity check.
  if (backPassport) {
    const reference = frontMrz || frontVisual;
    const match = passportNumbersMatch(backPassport, reference);
    passportConsistent = match === null ? false : match;
    crossPageCheckPerformed = true;
  }

  // TIER 2: MRZ optional data vs back-page file number (numeric portion).
  // Indian passports embed the file number (sans RPO prefix) in the TD3 optional
  // data field of MRZ line 2 (positions 28–41).  This is checksum-covered and
  // is the most reliable anchor when the barcode passport number is absent.
  // Both tiers must agree when both are available.
  if (mrzOptionalData && fileNumberNumeric) {
    fileNumberMrzMatch = mrzOptionalData === fileNumberNumeric;
    if (!fileNumberMrzMatch) {
      passportConsistent = false;
    }
    if (!crossPageCheckPerformed) {
      crossPageCheckPerformed = true;  // Tier 2 is also a genuine cross-page check
    }
  } else if (!backPassport) {
    // ── INTRA-FRONT FALLBACK ────────────────────────────────────────────────
    // Neither Tier 1 nor Tier 2 was possible (no back passport number, no
    // usable MRZ optional data or file number).  Compare visual vs MRZ on the
    // same front page — catches front-page tampering but not page swapping.
    const match = passportNumbersMatch(frontVisual, frontMrz);
    if (match !== null) passportConsistent = match;
    crossPageCheckPerformed = false;
  }

  // ── Place of Issue & RPO Code (Cross-Page Consistency) ───────────────────
  const frontPlaceOfIssue = ocr?.front?.place_of_issue || ocr?.place_of_issue || null;
  const frontRpo = frontPlaceOfIssue ? inferRpoCodeFromCity(frontPlaceOfIssue) : null;

  // ── Date of Issue (for detail output only) ──────────────────────────────
  const issueDateStr = ocr?.front?.date_of_issue || ocr?.date_of_issue || null;

  // ── RPO consistency ────────────────────────────────────────────────────────
  const addressRaw  = String(ocr?.back?.address_block || ocr?.address || '').trim();
  const parsedAddress = parseAddressBlock(addressRaw);
  const fileRpo       = extractRpoCode(fileNumber);
  const addressRpo    = inferRpoCodeFromAddress(parsedAddress);


  // 1. File RPO vs Address RPO (back-page internal check)
  let rpoConsistent = true;
  if (fileRpo && addressRpo) {
    rpoConsistent = fileRpo === addressRpo;
  }

  // 2. Front RPO vs File RPO (cross-page check)
  let rpoCrossPageConsistent = true;
  if (frontRpo && fileRpo) {
    rpoCrossPageConsistent = frontRpo === fileRpo;
  }

  // 3. Front RPO vs Address RPO (cross-page check)
  let rpoAddressCrossPageConsistent = true;
  if (frontRpo && addressRpo) {
    rpoAddressCrossPageConsistent = frontRpo === addressRpo;
  }

  const allConsistencyChecksPassed =
    passportConsistent &&
    rpoConsistent &&
    rpoCrossPageConsistent &&
    rpoAddressCrossPageConsistent;

  return {
    front_back_consistency_valid: allConsistencyChecksPassed,
    details: {
      // Whether we performed a true cross-page check (back passport vs front
      // MRZ) or only an intra-front fallback (visual vs MRZ, same page).
      cross_page_check_performed: crossPageCheckPerformed,
      front_visual_passport:      frontVisual  || null,
      front_mrz_passport:         frontMrz     || null,
      back_passport:              backPassport  || null,
      mrz_optional_data:          mrzOptionalData || null,
      file_number_numeric:        fileNumberNumeric || null,
      file_number_mrz_match:      fileNumberMrzMatch,
      passport_consistent:        passportConsistent,
      front_place_of_issue:       frontPlaceOfIssue,
      front_rpo:                  frontRpo,
      file_rpo:                   fileRpo,
      address_rpo:                addressRpo,
      rpo_consistent:             rpoConsistent,
      rpo_cross_page_consistent:  rpoCrossPageConsistent,
      rpo_address_cross_page_consistent: rpoAddressCrossPageConsistent,
      date_of_issue:              issueDateStr,
      front_has_mrz:              Boolean(ocr?.front?.mrz_line2),
      back_has_address:           Boolean(addressRaw)
    }
  };
}
