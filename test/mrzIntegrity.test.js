import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMrzLine1,
  validateMrzChecksums,
  validateMrzCompositeCheck
} from '../src/validators/mrzChecksum.js';
import { runMrzIntegrityChecks } from '../src/validators/mrzIntegrity.js';

test('parseMrzLine1 extracts issuing country and names', () => {
  const parsed = parseMrzLine1('P<INDA LEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
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
    null,
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

// ── visual_raw cross-check integrity fix ─────────────────────────────────────
// When front.visual_raw is present, cross-checks must use it (not front.*).
// front.* values are MRZ-assisted — using them makes the check circular.

test('visual_raw: mrz_visual_passport_match is false when C-prefix is hidden in visual field', () => {
  // Simulates user's test: the C prefix of C2203304 was physically obscured.
  // OCR reads "2203304" from the printed field; MRZ still has "C2203304".
  // Without visual_raw the check was: C2203304 vs C2203304 (circular) → true.
  // With visual_raw the check is:     C2203304 vs 2203304              → false.
  const mrzLine2 = 'C2203304<6IND7410149M34091092076925493724<02';
  const parsed = {
    passportNumber: 'C2203304',
    dateOfBirthRaw: '741014',
    expiryDateRaw:  '340910',
    nationality: 'IND'
  };
  const checksum = validateMrzChecksums(mrzLine2);

  const result = runMrzIntegrityChecks(
    {
      front: {
        mrz_line1: 'P<INDSANTHARAM<<VAITHEESWARAN<<<<<<<<<<<<<<<',
        mrz_line2: mrzLine2,
        passport_number: 'C2203304',   // MRZ-assisted (what extracted_data shows)
        date_of_birth:   '1974-10-14', // MRZ-assisted
        expiry_date:     '2034-09-10', // MRZ-assisted
        visual_raw: {
          passport_number: '2203304',  // raw OCR — C prefix was hidden
          date_of_birth:   null,        // raw OCR — year digit was hidden, can't parse
          expiry_date:     '2034-09-10' // raw OCR — expiry was unaltered
        }
      }
    },
    parsed,
    checksum
  );

  assert.equal(result.mrz_visual_passport_match, false,
    'hidden C-prefix must cause passport match to fail');
  assert.equal(result.visual_passport_present, true,
    'visual passport is present (7 digits were visible) so penalty applies');
  assert.equal(result.visual_dob_present, false,
    'incomplete DOB year means visual DOB is null → cross-check skipped');
  assert.equal(result.mrz_checksums_valid, true,
    'intact MRZ checksums must still pass');
});

test('visual_raw: mrz_visual_passport_match is true for an unaltered passport', () => {
  // Baseline: visual_raw present and all values match MRZ — should still pass.
  const mrzLine2 = 'M7229450<7IND8207089F2503228<<<<<<<<<<<<<4';
  const parsed = { passportNumber: 'M7229450', dateOfBirthRaw: '820708', expiryDateRaw: '250322', nationality: 'IND' };
  const checksum = validateMrzChecksums(mrzLine2);

  const result = runMrzIntegrityChecks(
    {
      front: {
        mrz_line1: 'P<INDTEST<<PERSON<<<<<<<<<<<<<<<<<<<<<<<<<<<',
        mrz_line2: mrzLine2,
        passport_number: 'M7229450',
        date_of_birth:   '1982-07-08',
        expiry_date:     '2025-03-22',
        visual_raw: {
          passport_number: 'M7229450',  // same as MRZ — unaltered
          date_of_birth:   '1982-07-08',
          expiry_date:     '2025-03-22'
        }
      }
    },
    parsed,
    checksum
  );

  assert.equal(result.mrz_visual_passport_match, true,
    'unaltered passport must still pass the cross-check');
  assert.equal(result.mrz_visual_dob_match, true);
  assert.equal(result.mrz_visual_expiry_match, true);
});

test('runMrzIntegrityChecks auto-corrects swapped MRZ lines from OCR', () => {
  // Real-world case: OCR returned the alpha line (P<IND...) in mrz_line2 and
  // the numeric line in mrz_line1. Without the swap-guard the passport number
  // would parse as "PINDHALA" and all checksums would fail.
  const numericLine = 'M7229450<7IND8207089F2503228<<<<<<<<<<<<<4';
  const alphaLine   = 'P<INDTEST<<PERSON<<<<<<<<<<<<<<<<<<<<<<<<<<<';

  const checksum = validateMrzChecksums(numericLine);
  const parsedOk = {
    passportNumber: 'M7229450',
    dateOfBirthRaw: '820708',
    expiryDateRaw: '250322',
    nationality: 'IND'
  };

  const result = runMrzIntegrityChecks(
    {
      front: {
        mrz_line1: numericLine,  // SWAPPED: numeric in line1 slot
        mrz_line2: alphaLine,    // SWAPPED: alpha in line2 slot
        passport_number: 'M7229450'
      }
    },
    parsedOk,
    checksum
  );

  assert.equal(result.mrz_checksums_valid, true,
    'checksums must pass after the swap is corrected');
  assert.equal(result.mrz_line1_parse_valid, true,
    'parsedLine1 must succeed once lines are in the right slots');
  assert.equal(result.mrz_country_valid, true,
    'country must be IND after swap resolves the alpha line correctly');
});

// ── Garbled OCR nationality guard ────────────────────────────────────────────

test('runMrzIntegrityChecks does not penalise garbled OCR nationality values', () => {
  // Real-world case: OCR inserts a spurious < in the numeric MRZ line, shifting
  // the nationality field so it reads as a single character ('Y') or a mixed
  // value ('1IN') rather than 'IND'. These must not count as confirmed foreign.
  const garbledValues = ['Y', '1IN', '<<<', 'X', '12'];

  for (const nationality of garbledValues) {
    const result = runMrzIntegrityChecks(
      { front: {} },
      { passportNumber: 'K0037575', nationality, dateOfBirthRaw: '770610', expiryDateRaw: '211208' },
      { valid: true, details: {} }
    );

    assert.equal(result.mrz_country_valid, true,
      `garbled nationality '${nationality}' must not fail mrz_country_valid`);
  }
});
