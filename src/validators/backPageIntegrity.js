import { extractRpoCode, parseAddressBlock } from './rpoMapping.js';

// Matches current format (2–3 letter RPO + 8–15 digits)
// and the pre-2014 format where the RPO code could be 4 letters
// (e.g. MASA = RPO Madras + sub-code A).
const FILE_NUMBER_PATTERN = /^[A-Z]{2,4}[0-9]{8,15}$/;
const PIN_PATTERN = /^[1-9][0-9]{5}$/;

export function runBackPageIntegrityChecks(fileNumber, addressRaw) {
  const normalizedFileNumber = String(fileNumber || '').toUpperCase().trim();
  const parsedAddress = parseAddressBlock(addressRaw || '');
  const pinCode = parsedAddress.pin_code;

  const fileNumberFormatValid =
    normalizedFileNumber.length > 0 && FILE_NUMBER_PATTERN.test(normalizedFileNumber);
  const pinCodeFormatValid = pinCode ? PIN_PATTERN.test(pinCode) : false;

  const addressText = String(addressRaw || '').trim();
  const hasPinMention = /\b(?:PIN\s*[:\-]?\s*)?\d{6}\b/i.test(addressText) ||
    /\b\d{3}\s\d{3}\b/.test(addressText);  // e.g. "600 024" (space-split PIN in old OCR)
  const hasRegionHint = /\b(?:INDIA|[A-Z]{4,}(?:,\s*[A-Z]{4,})?)\b/i.test(addressText);
  const addressStructureValid =
    addressText.length >= 20 && (pinCodeFormatValid || (hasPinMention && hasRegionHint));

  const rpoFromFile = extractRpoCode(normalizedFileNumber);

  return {
    file_number_format_valid: fileNumberFormatValid,
    pin_code_format_valid: pinCodeFormatValid,
    address_structure_valid: addressStructureValid,
    details: {
      file_number: normalizedFileNumber || null,
      rpo_from_file: rpoFromFile,
      parsed_address: parsedAddress
    }
  };
}
