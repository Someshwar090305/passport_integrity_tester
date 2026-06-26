import { extractRpoCode, inferRpoCodeFromAddress, parseAddressBlock } from './rpoMapping.js';
import { parseMrzLine2 } from './mrzChecksum.js';

function normalizePassportNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

export function runDocumentConsistencyChecks(ocr) {
  const frontPassport = normalizePassportNumber(ocr?.front?.passport_number);
  const topLevelPassport = normalizePassportNumber(ocr?.passport_number);

  // The Indian passport back page does not print a visual passport number, so
  // ocr.back.passport_number is always empty. Instead we cross-check the
  // visual front number against the MRZ-encoded number — the actual
  // front-to-document consistency test.
  const mrzLine2 = ocr?.front?.mrz_line2 || ocr?.mrz?.line2 || ocr?.mrz_line2 || '';
  const parsedMrz = parseMrzLine2(mrzLine2);
  const mrzPassport = normalizePassportNumber(parsedMrz?.passportNumber);

  let passportConsistent = true;
  const passportNumbers = [frontPassport, topLevelPassport, mrzPassport].filter(Boolean);

  if (passportNumbers.length >= 2) {
    const unique = new Set(passportNumbers);
    passportConsistent = unique.size === 1;
  }

  const fileNumber = String(ocr?.back?.file_number || ocr?.file_number || '').toUpperCase().trim();
  const addressRaw = String(ocr?.back?.address_block || ocr?.address || '').trim();
  const parsedAddress = parseAddressBlock(addressRaw);
  const fileRpo = extractRpoCode(fileNumber);
  const addressRpo = inferRpoCodeFromAddress(parsedAddress);

  let rpoConsistent = true;
  if (fileRpo && addressRpo) {
    rpoConsistent = fileRpo === addressRpo;
  }

  const frontHasMrz = Boolean(ocr?.front?.mrz_line2);
  const backHasAddress = Boolean(addressRaw);

  return {
    front_back_consistency_valid: passportConsistent && rpoConsistent,
    details: {
      passport_numbers_seen: passportNumbers,
      passport_consistent: passportConsistent,
      mrz_passport: mrzPassport || null,
      file_rpo: fileRpo,
      address_rpo: addressRpo,
      rpo_consistent: rpoConsistent,
      front_has_mrz: frontHasMrz,
      back_has_address: backHasAddress
    }
  };
}
