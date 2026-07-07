import { extractRpoCode, inferRpoCodeFromAddress, parseAddressBlock } from './rpoMapping.js';
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
 * the same passport number under a "Passport No." label.  Comparing these two
 * values is the definitive front-vs-back identity check.
 *
 * When the back-page passport number is readable → true cross-page check.
 * When it is absent (OCR miss or older passport format) → we fall back to
 * comparing the visual front number against the MRZ-encoded front number,
 * which at least catches front-page tampering / corruption.
 *
 * ── RPO consistency (back-page internal) ────────────────────────────────────
 * The file number prefix (RPO code) must correspond to the address region.
 * This is a back-page internal check, but it catches back pages from a
 * completely different issuance region being paired with an unrelated front.
 */
export function runDocumentConsistencyChecks(ocr) {
  // ── Passport number sources ─────────────────────────────────────────────────
  const frontVisual = normalizePassportNumber(
    ocr?.front?.passport_number || ocr?.passport_number
  );
  const mrzLine2 = ocr?.front?.mrz_line2 || ocr?.mrz?.line2 || ocr?.mrz_line2 || '';
  const parsedMrz = parseMrzLine2(mrzLine2);
  const frontMrz  = normalizePassportNumber(parsedMrz?.passportNumber);

  // Primary cross-page anchor: passport number printed on the back page.
  const backPassport = normalizePassportNumber(ocr?.back?.passport_number);

  let passportConsistent = true;
  let crossPageCheckPerformed = false;

  if (backPassport) {
    // ── TRUE CROSS-PAGE CHECK ────────────────────────────────────────────────
    // Compare the back-page passport number against the MRZ passport number
    // (preferred — MRZ is checksum-verified) or the visual front number.
    const reference = frontMrz || frontVisual;
    const match = passportNumbersMatch(backPassport, reference);

    if (match === null) {
      // Back page has a number but the front OCR produced nothing — suspicious.
      passportConsistent = false;
    } else {
      passportConsistent = match;
    }
    crossPageCheckPerformed = true;

  } else {
    // ── INTRA-FRONT FALLBACK ─────────────────────────────────────────────────
    // Back page has no readable passport number (older format or OCR miss).
    // Compare the visual front number against the MRZ-encoded number instead.
    // This does NOT catch a back page from a different passport, but it does
    // catch front-page tampering where the printed number was changed but the
    // MRZ was not (or vice-versa).
    const match = passportNumbersMatch(frontVisual, frontMrz);
    if (match !== null) {
      passportConsistent = match;
    }
    // When both are null, passportConsistent stays true — nothing to compare.
    crossPageCheckPerformed = false;
  }

  // ── RPO consistency ────────────────────────────────────────────────────────
  const fileNumber = String(ocr?.back?.file_number || ocr?.file_number || '')
    .toUpperCase()
    .trim();
  const addressRaw  = String(ocr?.back?.address_block || ocr?.address || '').trim();
  const parsedAddress = parseAddressBlock(addressRaw);
  const fileRpo       = extractRpoCode(fileNumber);
  const addressRpo    = inferRpoCodeFromAddress(parsedAddress);

  let rpoConsistent = true;
  if (fileRpo && addressRpo) {
    rpoConsistent = fileRpo === addressRpo;
  }

  return {
    front_back_consistency_valid: passportConsistent && rpoConsistent,
    details: {
      // Whether we performed a true cross-page check (back passport vs front
      // MRZ) or only an intra-front fallback (visual vs MRZ, same page).
      cross_page_check_performed: crossPageCheckPerformed,
      front_visual_passport:      frontVisual  || null,
      front_mrz_passport:         frontMrz     || null,
      back_passport:              backPassport  || null,
      passport_consistent:        passportConsistent,
      file_rpo:                   fileRpo,
      address_rpo:                addressRpo,
      rpo_consistent:             rpoConsistent,
      front_has_mrz:              Boolean(ocr?.front?.mrz_line2),
      back_has_address:           Boolean(addressRaw)
    }
  };
}
