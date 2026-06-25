import test from 'node:test';
import assert from 'node:assert/strict';

import { runValidation, selectValidationResult } from '../src/services/validationEngine.js';

test('runValidation yields expanded integrity payload fields', () => {
  const result = runValidation({
    front: {
      mrz_line1: 'P<INDTEST<<PERSON<<<<<<<<<<<<<<<<<<<<<<<<<',
      mrz_line2: 'A12<<<<<<8IND9503096M3210142<<<<<<<<<<<<<<02',
      date_of_birth: '1995-03-09',
      passport_number: 'A12'
    },
    back: {
      file_number: 'MA3068341883515',
      address_block: 'Chennai, Tamil Nadu PIN 600089, INDIA'
    }
  });

  assert.ok(['PASSED', 'REVIEW_REQUIRED', 'FAILED'].includes(result.verificationStatus));
  assert.equal(typeof result.integrityFlags.mrz_checksums_valid, 'boolean');
  assert.equal(typeof result.integrityScore, 'number');
  assert.equal(typeof result.reviewRequired, 'boolean');
  assert.ok(Array.isArray(result.failedChecks));
  assert.equal(result.extractedData.rpo_code, 'MAA');
  assert.equal(result.extractedData.parsed_address.pin_code, '600089');
});

test('runValidation requires review when visual DOB is missing', () => {
  const mrzLine2 = 'M7229450<7IND8207089F2503228<<<<<<<<<<<<<4';
  const result = runValidation({
    front: {
      mrz_line1: 'P<INDTEST<<PERSON<<<<<<<<<<<<<<<<<<<<<<<<<',
      mrz_line2: mrzLine2,
      passport_number: 'M7229450'
    },
    back: {
      file_number: 'MA3068341883515',
      address_block:
        'Address NO.25/10,MARUTHI NAGAR,HASTHINAPURAM CHROMEPET,CHENNAI PIN:600064,TAMIL NADU,INDIA'
    }
  });

  assert.equal(result.integrityFlags.mrz_checksums_valid, true);
  assert.equal(result.integrityFlags.viz_mrz_crosscheck_valid, false);
  assert.equal(result.reviewRequired, true);
  assert.ok(['REVIEW_REQUIRED', 'FAILED'].includes(result.verificationStatus));
});

test('selectValidationResult prefers higher-scoring fallback validation', () => {
  const primary = { verificationStatus: 'FAILED', integrityScore: 40 };
  const fallback = { verificationStatus: 'REVIEW_REQUIRED', integrityScore: 72 };

  assert.equal(selectValidationResult(primary, fallback).verificationStatus, 'REVIEW_REQUIRED');
});
