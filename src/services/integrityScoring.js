const CHECK_DEFINITIONS = {
  mrz_checksums_valid: { severity: 'critical', weight: 20, message: 'MRZ checksum validation failed' },
  mrz_composite_check_valid: { severity: 'medium', weight: 8, message: 'MRZ composite check digit failed' },
  mrz_line1_parse_valid: { severity: 'medium', weight: 5, message: 'MRZ line 1 could not be parsed' },
  mrz_country_valid: { severity: 'critical', weight: 10, message: 'MRZ country/nationality is not IND' },
  mrz_visual_passport_match: { severity: 'critical', weight: 15, message: 'Visual passport number does not match MRZ' },
  mrz_visual_dob_match: { severity: 'medium', weight: 12, message: 'Visual DOB does not match MRZ' },
  mrz_visual_expiry_match: { severity: 'medium', weight: 10, message: 'Visual expiry does not match MRZ' },
  viz_mrz_crosscheck_valid: { severity: 'medium', weight: 12, message: 'Visual vs MRZ cross-check failed' },
  document_not_expired: { severity: 'critical', weight: 15, message: 'Passport is expired' },
  dob_plausible: { severity: 'critical', weight: 8, message: 'Date of birth is not plausible' },
  expiry_after_dob: { severity: 'critical', weight: 8, message: 'Expiry date is not after date of birth' },
  file_number_format_valid: { severity: 'medium', weight: 8, message: 'File number format is invalid' },
  pin_code_format_valid: { severity: 'medium', weight: 6, message: 'PIN code format is invalid' },
  address_structure_valid: { severity: 'medium', weight: 8, message: 'Address structure is incomplete' },
  rpo_address_mapping_valid: { severity: 'medium', weight: 10, message: 'RPO code does not match address region' },
  front_back_consistency_valid: { severity: 'critical', weight: 12, message: 'Front and back pages are inconsistent' }
};

const SKIPPED_WHEN_MISSING = new Set([
  'mrz_line1_parse_valid',
  'mrz_composite_check_valid',
  'mrz_visual_passport_match',
  'mrz_visual_expiry_match',
  'file_number_format_valid',
  'pin_code_format_valid',
  'address_structure_valid',
  'rpo_address_mapping_valid',
  'front_back_consistency_valid'
]);

function isApplicable(flag, value, context = {}) {
  if (value !== false) return true;

  if (flag === 'mrz_composite_check_valid' && context.mrz_composite_check_applicable === false) {
    return false;
  }

  if (flag === 'mrz_visual_dob_match' && context.visual_dob_present === false) {
    return false;
  }

  if (flag === 'viz_mrz_crosscheck_valid' && context.visual_dob_present === false) {
    return false;
  }

  if (flag === 'mrz_line1_parse_valid' && !context.mrz_line1_present) {
    return false;
  }

  if (flag === 'file_number_format_valid' && !context.file_number_present) {
    return false;
  }

  if (flag === 'pin_code_format_valid' && !context.pin_code_present) {
    return false;
  }

  if (flag === 'address_structure_valid' && !context.address_present) {
    return false;
  }

  if (flag === 'rpo_address_mapping_valid' && !context.rpo_mapping_applicable) {
    return false;
  }

  return true;
}

export function scoreIntegrity(integrityFlags, context = {}) {
  const failedChecks = [];
  let score = 100;

  for (const [flag, definition] of Object.entries(CHECK_DEFINITIONS)) {
    const flagValue = integrityFlags[flag];
    if (flagValue === undefined) continue;

    if (flagValue === false && !isApplicable(flag, flagValue, context)) {
      continue;
    }

    if (flagValue === false) {
      failedChecks.push({
        code: flag,
        severity: definition.severity,
        message: definition.message
      });
      score -= definition.weight;
    }
  }

  if (context.visual_dob_present === false) {
    failedChecks.push({
      code: 'visual_dob_missing',
      severity: 'medium',
      message: 'Visual date of birth missing; MRZ DOB cross-check could not be confirmed'
    });
    score -= 8;
  }

  score = Math.max(0, Math.min(100, score));

  const hasCriticalFail = failedChecks.some((check) => check.severity === 'critical');
  const hasMediumFail = failedChecks.some((check) => check.severity === 'medium');
  const reviewRequired = context.visual_dob_present === false || (hasMediumFail && !hasCriticalFail && score < 85);

  let verificationStatus = 'PASSED';
  let integrityTier = 'HIGH';

  if (hasCriticalFail || score < 60) {
    verificationStatus = 'FAILED';
    integrityTier = 'REJECT';
  } else if (reviewRequired || score < 85) {
    verificationStatus = 'REVIEW_REQUIRED';
    integrityTier = score >= 70 ? 'MEDIUM' : 'LOW';
  } else if (score >= 85) {
    verificationStatus = 'PASSED';
    integrityTier = 'HIGH';
  }

  return {
    integrity_score: score,
    integrity_tier: integrityTier,
    verification_status: verificationStatus,
    review_required: reviewRequired,
    failed_checks: failedChecks
  };
}
