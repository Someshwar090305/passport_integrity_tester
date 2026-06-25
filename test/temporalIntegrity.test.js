import test from 'node:test';
import assert from 'node:assert/strict';

import { runTemporalIntegrityChecks } from '../src/validators/temporalIntegrity.js';

test('runTemporalIntegrityChecks accepts valid future expiry', () => {
  const result = runTemporalIntegrityChecks({
    date_of_birth: '1995-03-09',
    expiry_date: '2032-10-14'
  });

  assert.equal(result.dob_plausible, true);
  assert.equal(result.document_not_expired, true);
  assert.equal(result.expiry_after_dob, true);
});

test('runTemporalIntegrityChecks rejects expired passport', () => {
  const result = runTemporalIntegrityChecks({
    date_of_birth: '1974-08-12',
    expiry_date: '2012-04-15'
  });

  assert.equal(result.document_not_expired, false);
});
