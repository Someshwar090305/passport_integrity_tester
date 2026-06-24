import test from 'node:test';
import assert from 'node:assert/strict';

import { runValidation, selectValidationResult } from '../src/services/validationEngine.js';

test('runValidation yields expected payload fields', () => {
  const result = runValidation({
    front: {
      mrz_line2: 'A12<<<<<<8IND9503096M3210142<<<<<<<<<<<<<<02',
      date_of_birth: '1995-03-09'
    },
    back: {
      file_number: 'MAA1234567',
      address_block: 'Chennai, Tamil Nadu 600089'
    }
  });

  assert.ok(result.verificationStatus === 'PASSED' || result.verificationStatus === 'FAILED');
  assert.equal(typeof result.integrityFlags.mrz_checksums_valid, 'boolean');
  assert.equal(result.extractedData.rpo_code, 'MAA');
  assert.equal(result.extractedData.parsed_address.pin_code, '600089');
});

test('runValidation passes when visual DOB missing but MRZ valid', () => {
  const mrzLine2 = 'M7229450<7IND8207089F2503228<<<<<<<<<<<<<4';
  const result = runValidation({
    front: {
      mrz_line2: mrzLine2
      // Intentionally omit visual DOB so visualCrosscheck must rely on MRZ validity.
    },
    back: {
      file_number: 'MA3068341883515',
      address_block:
        'Address NO.25/10,MARUTHI NAGAR,HASTHINAPURAM CHROMEPURAM CHROMEPET,CHENNAI PIN:600064,TAMIL NADU,INDIA'
    }
  });

  assert.equal(result.integrityFlags.mrz_checksums_valid, true);
  assert.equal(result.integrityFlags.viz_mrz_crosscheck_valid, true);
  assert.equal(result.verificationStatus, 'PASSED');
});

test('selectValidationResult prefers the fallback validation result when present', () => {
  const primary = { verificationStatus: 'FAILED' };
  const fallback = { verificationStatus: 'PASSED' };

  assert.equal(selectValidationResult(primary, fallback).verificationStatus, 'PASSED');
});
