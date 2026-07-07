import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMrzLine1,
  validateMrzChecksums,
  validateMrzCompositeCheck
} from '../src/validators/mrzChecksum.js';
import { runMrzIntegrityChecks } from '../src/validators/mrzIntegrity.js';

test('parseMrzLine1 extracts issuing country and names', () => {
  const parsed = parseMrzLine1('P<INDA LEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<');
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
        mrz_line1: 'P<INDTEST<<PERSON<<<<<<<<<<<<<<<<<<<<<<<<<<<',
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

// ── C1: mrz_visual_passport_match null-pass fix ───────────────────────────────

test('C1: mrz_visual_passport_match is false when visual number is missing but MRZ has one', () => {
  const mrzLine2 = 'M7229450<7IND8207089F2503228<<<<<<<<<<<<<4';
  const parsed = { passportNumber: 'M7229450', dateOfBirthRaw: '820708', expiryDateRaw: '250322', nationality: 'IND' };
  const checksum = validateMrzChecksums(mrzLine2);

  const result = runMrzIntegrityChecks(
    {
      front: {
        mrz_line2: mrzLine2
        // no passport_number on the visual front — simulates failed OCR read
      }
    },
    parsed,
    checksum
  );

  assert.equal(result.mrz_visual_passport_match, false,
    'should be false when visual number is absent but MRZ number is present');
  assert.equal(result.visual_passport_present, false);
  assert.equal(result.mrz_passport_present, true);
});

test('C1: mrz_visual_passport_match is false when MRZ is missing but visual number is present', () => {
  // No MRZ line 2 → parsedMrz is null → mrzPassport is null.
  const result = runMrzIntegrityChecks(
    { front: { passport_number: 'A1234567' } },
    null,  // parsedMrz
    { valid: false, details: {} }
  );

  assert.equal(result.mrz_visual_passport_match, false,
    'should be false when MRZ number is absent but visual number is present');
  assert.equal(result.visual_passport_present, true);
  assert.equal(result.mrz_passport_present, false);
});

test('C1: mrz_visual_passport_match context flags are false when both numbers are absent', () => {
  // Neither visual nor MRZ has a passport number — check should be skipped by scorer.
  const result = runMrzIntegrityChecks(
    { front: {} },
    null,
    { valid: false, details: {} }
  );

  assert.equal(result.visual_passport_present, false);
  assert.equal(result.mrz_passport_present, false);
  // The flag itself is false (no match possible), but the scorer will skip it
  // when both presence flags are false.
  assert.equal(result.mrz_visual_passport_match, false);
});
