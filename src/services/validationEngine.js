import { parseMrzLine2, validateMrzChecksums } from '../validators/mrzChecksum.js';
import { runMrzIntegrityChecks } from '../validators/mrzIntegrity.js';
import { runTemporalIntegrityChecks } from '../validators/temporalIntegrity.js';
import { runBackPageIntegrityChecks } from '../validators/backPageIntegrity.js';
import { runDocumentConsistencyChecks } from '../validators/documentConsistency.js';
import {
  extractRpoCode,
  inferRpoCodeFromAddress,
  parseAddressBlock,
  validateRpoAddressMapping
} from '../validators/rpoMapping.js';
import { scoreIntegrity } from './integrityScoring.js';
import { pick, yyMmDdToIso } from '../utils/helpers.js';

export function selectValidationResult(primaryValidation, fallbackValidation) {
  if (!fallbackValidation) return primaryValidation;

  const primaryScore = primaryValidation.integrityScore ?? 0;
  const fallbackScore = fallbackValidation.integrityScore ?? 0;

  if (fallbackScore > primaryScore) return fallbackValidation;
  if (fallbackScore === primaryScore) {
    const statusRank = { PASSED: 3, REVIEW_REQUIRED: 2, FAILED: 1 };
    const primaryRank = statusRank[primaryValidation.verificationStatus] || 0;
    const fallbackRank = statusRank[fallbackValidation.verificationStatus] || 0;
    if (fallbackRank > primaryRank) return fallbackValidation;
  }

  return primaryValidation;
}

export function runValidation(ocr) {
  let mrzLine1 = pick(ocr?.mrz?.line1, ocr?.front?.mrz_line1, ocr?.mrz_line1, '');
  let mrzLine2 = pick(ocr?.mrz?.line2, ocr?.front?.mrz_line2, ocr?.mrz_line2, '');

  // Guard: OCR engines sometimes return MRZ lines in the wrong slots.
  // Line 1 (alpha line) always begins with 'P<'; Line 2 (numeric line) never does.
  // This condition is impossible for a correctly-ordered pair, so the swap only
  // fires when the OCR clearly handed us Line 1 content in the Line 2 slot.
  const _l1 = String(mrzLine1).replace(/[^A-Z0-9<]/gi, '').toUpperCase();
  const _l2 = String(mrzLine2).replace(/[^A-Z0-9<]/gi, '').toUpperCase();
  if (_l2.startsWith('P<') && !_l1.startsWith('P<')) {
    [mrzLine1, mrzLine2] = [mrzLine2, mrzLine1];
  }

  const parsedMrz = parseMrzLine2(mrzLine2);
  const mrzResult = validateMrzChecksums(mrzLine2);

  const fileNumber = pick(ocr?.back?.file_number, ocr?.file_number, '');
  const addressRaw = pick(ocr?.back?.address_block, ocr?.address, '');
  const parsedAddress = parseAddressBlock(addressRaw);
  const rpoCode = extractRpoCode(fileNumber) || inferRpoCodeFromAddress(parsedAddress);

  const mrzIntegrity = runMrzIntegrityChecks(ocr, parsedMrz, mrzResult);
  const backPageIntegrity = runBackPageIntegrityChecks(fileNumber, addressRaw);
  const documentConsistency = runDocumentConsistencyChecks(ocr);
  const rpoAddressMappingValid = validateRpoAddressMapping(rpoCode, parsedAddress);

  const extractedData = {
    passport_number: parsedMrz?.passportNumber || pick(ocr?.passport_number, null),
    date_of_birth: yyMmDdToIso(parsedMrz?.dateOfBirthRaw || '') || pick(ocr?.front?.date_of_birth, ocr?.date_of_birth, null),
    expiry_date: yyMmDdToIso(parsedMrz?.expiryDateRaw || '') || pick(ocr?.expiry_date, null),
    file_number: fileNumber || null,
    rpo_code: rpoCode,
    parsed_address: {
      pin_code: parsedAddress.pin_code,
      city: parsedAddress.city,
      state: parsedAddress.state || null
    }
  };

  const temporalIntegrity = runTemporalIntegrityChecks(extractedData);

  const integrityFlags = {
    mrz_checksums_valid: mrzIntegrity.mrz_checksums_valid,
    mrz_composite_check_valid: mrzIntegrity.mrz_composite_check_valid,
    mrz_line1_parse_valid: mrzIntegrity.mrz_line1_parse_valid,
    mrz_country_valid: mrzIntegrity.mrz_country_valid,
    mrz_visual_passport_match: mrzIntegrity.mrz_visual_passport_match,
    mrz_visual_dob_match: mrzIntegrity.mrz_visual_dob_match,
    mrz_visual_expiry_match: mrzIntegrity.mrz_visual_expiry_match,
    viz_mrz_crosscheck_valid: mrzIntegrity.visual_dob_present
      ? mrzIntegrity.mrz_visual_dob_match
      : false,
    document_not_expired: temporalIntegrity.document_not_expired,
    dob_plausible: temporalIntegrity.dob_plausible,
    expiry_after_dob: temporalIntegrity.expiry_after_dob,
    file_number_format_valid: backPageIntegrity.file_number_format_valid,
    pin_code_format_valid: backPageIntegrity.pin_code_format_valid,
    address_structure_valid: backPageIntegrity.address_structure_valid,
    rpo_address_mapping_valid: rpoAddressMappingValid,
    front_back_consistency_valid: documentConsistency.front_back_consistency_valid
  };

  const scoringContext = {
    visual_dob_present: mrzIntegrity.visual_dob_present,
    visual_passport_present: mrzIntegrity.visual_passport_present,
    mrz_passport_present: mrzIntegrity.mrz_passport_present,
    mrz_composite_check_applicable: mrzIntegrity.mrz_composite_check_applicable,
    mrz_line1_present: Boolean(mrzLine1),
    file_number_present: Boolean(fileNumber),
    pin_code_present: Boolean(parsedAddress.pin_code),
    address_present: Boolean(addressRaw),
    rpo_mapping_applicable: Boolean(rpoCode && parsedAddress && (parsedAddress.city || parsedAddress.state))
  };

  const scoring = scoreIntegrity(integrityFlags, scoringContext);

  return {
    verificationStatus: scoring.verification_status,
    integrityFlags,
    integrityScore: scoring.integrity_score,
    integrityTier: scoring.integrity_tier,
    reviewRequired: scoring.review_required,
    failedChecks: scoring.failed_checks,
    extractedData,
    extractedFeatures: {
      mrz: {
        line1: mrzLine1 || null,
        line2: mrzLine2 || null,
        passport_number: parsedMrz?.passportNumber || null,
        nationality: parsedMrz?.nationality || null,
        date_of_birth_raw: parsedMrz?.dateOfBirthRaw || null,
        expiry_date_raw: parsedMrz?.expiryDateRaw || null,
        sex: parsedMrz?.sex || null,
        checksum_details: mrzResult.details,
        composite_check_applicable: mrzIntegrity.mrz_composite_check_applicable
      },
      visual: {
        // Raw visual values — what OCR read from the printed page, without any
        // MRZ correction. Null means OCR could not read the field.
        date_of_birth_raw:    pick(ocr?.front?.visual_raw?.date_of_birth,   ocr?.front?.date_of_birth,   ocr?.date_of_birth,   null),
        passport_number_raw:  pick(ocr?.front?.visual_raw?.passport_number, ocr?.front?.passport_number, ocr?.passport_number, null),
        expiry_date_raw:      pick(ocr?.front?.visual_raw?.expiry_date,      ocr?.front?.expiry_date,      ocr?.expiry_date,      null)
      },
      back_page: {
        file_number_raw: fileNumber || null,
        address_block_raw: addressRaw || null,
        parsed_address: parsedAddress,
        // Passport number extracted from the barcode printed on the back page
        // (top-right corner). null when OCR could not read it (e.g. misread Z→2).
        // In that case Tier 2 (MRZ optional data ↔ file number) takes over.
        passport_number_raw: pick(ocr?.back?.passport_number, null)
      },
      inferred: {
        rpo_code: rpoCode || null
      },
      integrity: {
        mrz: mrzIntegrity.details,
        temporal: temporalIntegrity.details,
        back_page: backPageIntegrity.details,
        document_consistency: documentConsistency.details
      }
    }
  };
}
