import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMrzLine1,
  validateMrzChecksums,
  validateMrzCompositeCheck
} from '../src/validators/mrzChecksum.js';
import { runMrzIntegrityChecks } from '../src/validators/mrzIntegrity.js';

test('parseMrzLine1 extracts issuing country and names', () => {
  const parsed = parseMrzLine1('P<INDALEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<');
  assert.equal(parsed.issuingCountry, 'IND');
  assert.equal(parsed.surname, 'ALEXANDER');
  assert.equal(parsed.givenNames, 'JOHN');
});

test('runMrzIntegrityChecks flags missing visual DOB cross-check', () => {
  const mrzLine2 = 'M7229450<7IND8207089F2503228<<<<<<<<<<<<<4';
  const parsed = { passportNumber: 'M7229450', dateOfBirthRaw: '820708', expiryDateRaw: '250322', nationality: 'IND' };
  const checksum = validateMrzChecksums(mrzLine2);

  const result = runMrzIntegrityChecks(
    {
      front: {
        mrz_line1: 'P<INDTEST<<PERSON<<<<<<<<<<<<<<<<<<<<<<<<<',
        mrz_line2: mrzLine2,
        passport_number: 'M7229450'
      }
    },
    parsed,
    checksum
  );

  assert.equal(result.mrz_checksums_valid, true);
  assert.equal(result.visual_dob_present, false);
  assert.equal(result.mrz_visual_dob_match, false);
});

test('validateMrzCompositeCheck reports applicability for truncated MRZ', () => {
  const truncated = validateMrzCompositeCheck('M7229450<7IND8207089F2503228<<<<<<<<<<<<<4');
  assert.equal(truncated.applicable, false);

  const fullLine = 'L898902C36IND7408122F1204159ZE184226B<<<<<10';
  const full = validateMrzCompositeCheck(fullLine);
  assert.equal(full.applicable, true);
  assert.equal(typeof full.valid, 'boolean');
});
