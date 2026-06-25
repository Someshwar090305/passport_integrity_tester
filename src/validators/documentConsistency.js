import { extractRpoCode, inferRpoCodeFromAddress, parseAddressBlock } from './rpoMapping.js';

function normalizePassportNumber(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

export function runDocumentConsistencyChecks(ocr) {
  const frontPassport = normalizePassportNumber(ocr?.front?.passport_number);
  const backPassport = normalizePassportNumber(ocr?.back?.passport_number);
  const topLevelPassport = normalizePassportNumber(ocr?.passport_number);

  let passportConsistent = true;
  const passportNumbers = [frontPassport, backPassport, topLevelPassport].filter(Boolean);

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
      file_rpo: fileRpo,
      address_rpo: addressRpo,
      rpo_consistent: rpoConsistent,
      front_has_mrz: frontHasMrz,
      back_has_address: backHasAddress
    }
  };
}
