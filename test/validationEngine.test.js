import test from 'node:test';
import assert from 'node:assert/strict';

import { runValidation } from '../src/services/validationEngine.js';
import { normalizeSarvamResponse } from '../src/providers/sarvamClient.js';

test('normalizeSarvamResponse supports nested response shape', () => {
  const normalized = normalizeSarvamResponse({
    data: {
      front: { mrz_line2: 'V1234567<8IND9503096M3210142<<<<<<<<<<<<<<02' },
      back: { file_number: 'MAA1234567', address_block: 'Chennai, Tamil Nadu 600089' }
    },
    visual: { date_of_birth: '1995-03-09' }
  });

  assert.equal(normalized.front.date_of_birth, '1995-03-09');
  assert.equal(normalized.back.file_number, 'MAA1234567');
});

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
