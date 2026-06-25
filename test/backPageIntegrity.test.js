import test from 'node:test';
import assert from 'node:assert/strict';

import { runBackPageIntegrityChecks } from '../src/validators/backPageIntegrity.js';

test('runBackPageIntegrityChecks validates Indian file number and PIN', () => {
  const result = runBackPageIntegrityChecks(
    'MA3068341883515',
    'Address NO.25/10,MARUTHI NAGAR,CHENNAI PIN:600064,TAMIL NADU,INDIA'
  );

  assert.equal(result.file_number_format_valid, true);
  assert.equal(result.pin_code_format_valid, true);
  assert.equal(result.address_structure_valid, true);
});

test('runBackPageIntegrityChecks rejects malformed file number', () => {
  const result = runBackPageIntegrityChecks('12345', 'Short');
  assert.equal(result.file_number_format_valid, false);
});
