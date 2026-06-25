import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreIntegrity } from '../src/services/integrityScoring.js';

test('scoreIntegrity returns PASSED for all-valid flags', () => {
  const result = scoreIntegrity(
    {
      mrz_checksums_valid: true,
      mrz_composite_check_valid: true,
      mrz_line1_parse_valid: true,
      mrz_country_valid: true,
      mrz_visual_passport_match: true,
      mrz_visual_dob_match: true,
      mrz_visual_expiry_match: true,
      viz_mrz_crosscheck_valid: true,
      document_not_expired: true,
      dob_plausible: true,
      expiry_after_dob: true,
      file_number_format_valid: true,
      pin_code_format_valid: true,
      address_structure_valid: true,
      rpo_address_mapping_valid: true,
      front_back_consistency_valid: true
    },
    { visual_dob_present: true, mrz_composite_check_applicable: true, mrz_line1_present: true }
  );

  assert.equal(result.verification_status, 'PASSED');
  assert.equal(result.review_required, false);
  assert.ok(result.integrity_score >= 85);
});

test('scoreIntegrity returns REVIEW_REQUIRED when visual DOB is missing', () => {
  const result = scoreIntegrity(
    {
      mrz_checksums_valid: true,
      mrz_composite_check_valid: true,
      mrz_country_valid: true,
      mrz_visual_passport_match: true,
      mrz_visual_dob_match: false,
      mrz_visual_expiry_match: true,
      viz_mrz_crosscheck_valid: false,
      document_not_expired: true,
      dob_plausible: true,
      expiry_after_dob: true,
      file_number_format_valid: true,
      pin_code_format_valid: true,
      address_structure_valid: true,
      rpo_address_mapping_valid: true,
      front_back_consistency_valid: true
    },
    { visual_dob_present: false, mrz_composite_check_applicable: false, mrz_line1_present: true }
  );

  assert.equal(result.verification_status, 'REVIEW_REQUIRED');
  assert.equal(result.review_required, true);
});

test('scoreIntegrity returns FAILED on critical MRZ checksum failure', () => {
  const result = scoreIntegrity(
    {
      mrz_checksums_valid: false,
      mrz_country_valid: true,
      document_not_expired: true,
      dob_plausible: true,
      expiry_after_dob: true
    },
    { visual_dob_present: true }
  );

  assert.equal(result.verification_status, 'FAILED');
  assert.ok(result.failed_checks.some((check) => check.code === 'mrz_checksums_valid'));
});
