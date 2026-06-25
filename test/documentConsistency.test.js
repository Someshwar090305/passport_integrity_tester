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
  const result = runDocumentConsistencyChecks({
    front: { passport_number: 'A1111111' },
    back: { passport_number: 'B2222222' },
    passport_number: 'A1111111'
  });

  assert.equal(result.front_back_consistency_valid, false);
});
