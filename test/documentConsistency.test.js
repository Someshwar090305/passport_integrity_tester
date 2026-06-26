import test from 'node:test';
import assert from 'node:assert/strict';

import { runDocumentConsistencyChecks } from '../src/validators/documentConsistency.js';

test('runDocumentConsistencyChecks passes when front/back agree', () => {
  const result = runDocumentConsistencyChecks({
    front: { passport_number: 'M7229450', mrz_line2: 'M7229450<7IND8207089F2503228' },
    back: {
      file_number: 'MA3068341883515',
      address_block: 'CHENNAI PIN 600064, TAMIL NADU, INDIA'
    },
    passport_number: 'M7229450'
  });

  assert.equal(result.front_back_consistency_valid, true);
});

test('runDocumentConsistencyChecks fails on conflicting passport numbers', () => {
  // Visual passport number on the front contradicts the MRZ-encoded number.
  // ocr.back.passport_number is never populated by the OCR client (the Indian
  // back page has no visual passport number field), so the real conflict check
  // compares the front visual field against the MRZ-derived value.
  const result = runDocumentConsistencyChecks({
    front: {
      passport_number: 'A1111111',
      // MRZ line 2 encodes a different passport number — genuine conflict
      mrz_line2: 'B2222222<7IND8207089F2503228'
    },
    passport_number: 'A1111111'
  });

  assert.equal(result.front_back_consistency_valid, false);
});
