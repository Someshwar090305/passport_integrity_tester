import test from 'node:test';
import assert from 'node:assert/strict';

import { validateMrzChecksums } from '../src/validators/mrzChecksum.js';
import { validateVisualMrzDobMatch } from '../src/validators/visualCrosscheck.js';
import { extractRpoCode, parseAddressBlock, validateRpoAddressMapping } from '../src/validators/rpoMapping.js';

test('validateMrzChecksums returns false for malformed MRZ', () => {
  const result = validateMrzChecksums('SHORT');
  assert.equal(result.valid, false);
});

test('visual MRZ DOB check accepts equivalent formats', () => {
  const valid = validateVisualMrzDobMatch('950309', '1995-03-09');
  assert.equal(valid, true);
});

test('RPO parser and mapping validates known region', () => {
  const rpo = extractRpoCode('MAA1234567890');
  const parsed = parseAddressBlock('12 Test St, Chennai, Tamil Nadu 600089');
  const isValid = validateRpoAddressMapping(rpo, parsed);
  assert.equal(rpo, 'MAA');
  assert.equal(parsed.pin_code, '600089');
  assert.equal(isValid, true);
});
