import { parseMrzLine2, validateMrzChecksums } from '../validators/mrzChecksum.js';
import { validateVisualMrzDobMatch } from '../validators/visualCrosscheck.js';
import {
  extractRpoCode,
  inferRpoCodeFromAddress,
  parseAddressBlock,
  validateRpoAddressMapping
} from '../validators/rpoMapping.js';

function yyMmDdToIso(value) {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = value.slice(2, 4);
  const dd = value.slice(4, 6);
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
}

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

export function runValidation(ocr) {
  const mrzLine2 = pick(ocr?.mrz?.line2, ocr?.front?.mrz_line2, ocr?.mrz_line2, '');
  const parsedMrz = parseMrzLine2(mrzLine2);
  const mrzResult = validateMrzChecksums(mrzLine2);

  const visualDob = pick(
    ocr?.front?.date_of_birth,
    ocr?.date_of_birth,
    ocr?.visual?.date_of_birth,
    null
  );

  const visualCrosscheck = validateVisualMrzDobMatch(parsedMrz?.dateOfBirthRaw, visualDob);

  const fileNumber = pick(ocr?.back?.file_number, ocr?.file_number, '');
  const addressRaw = pick(ocr?.back?.address_block, ocr?.address, '');
  const parsedAddress = parseAddressBlock(addressRaw);
  const rpoCode = extractRpoCode(fileNumber) || inferRpoCodeFromAddress(parsedAddress);
  const rpoAddressMappingValid = validateRpoAddressMapping(rpoCode, parsedAddress);

  const integrityFlags = {
    mrz_checksums_valid: mrzResult.valid,
    viz_mrz_crosscheck_valid: visualCrosscheck,
    rpo_address_mapping_valid: rpoAddressMappingValid
  };

  const verificationStatus = Object.values(integrityFlags).every(Boolean) ? 'PASSED' : 'FAILED';

  return {
    verificationStatus,
    integrityFlags,
    extractedData: {
      passport_number: parsedMrz?.passportNumber || pick(ocr?.passport_number, null),
      date_of_birth: yyMmDdToIso(parsedMrz?.dateOfBirthRaw || '') || visualDob || null,
      expiry_date: yyMmDdToIso(parsedMrz?.expiryDateRaw || '') || pick(ocr?.expiry_date, null),
      rpo_code: rpoCode,
      parsed_address: {
        pin_code: parsedAddress.pin_code,
        city: parsedAddress.city
      }
    },
    extractedFeatures: {
      mrz: {
        line2: mrzLine2 || null,
        passport_number: parsedMrz?.passportNumber || null,
        date_of_birth_raw: parsedMrz?.dateOfBirthRaw || null,
        expiry_date_raw: parsedMrz?.expiryDateRaw || null,
        checksum_details: mrzResult.details
      },
      visual: {
        date_of_birth_raw: visualDob || null
      },
      back_page: {
        file_number_raw: fileNumber || null,
        address_block_raw: addressRaw || null,
        parsed_address: parsedAddress
      },
      inferred: {
        rpo_code: rpoCode || null
      }
    }
  };
}
