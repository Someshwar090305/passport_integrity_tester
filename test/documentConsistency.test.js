import test from 'node:test';
import assert from 'node:assert/strict';

import { runDocumentConsistencyChecks } from '../src/validators/documentConsistency.js';

// ── Intra-front fallback (back page has no passport number) ───────────────────

test('runDocumentConsistencyChecks passes when front visual and MRZ agree (no back number)', () => {
  const result = runDocumentConsistencyChecks({
    front: { passport_number: 'M7229450', mrz_line2: 'M7229450<7IND8207089F2503228' },
    back: {
      file_number:    'MA3068341883515',
      address_block:  'CHENNAI PIN 600064, TAMIL NADU, INDIA'
      // no passport_number on back — intra-front fallback
    },
    passport_number: 'M7229450'
  });

  assert.equal(result.front_back_consistency_valid, true);
  assert.equal(result.details.cross_page_check_performed, false,
    'should use intra-front fallback when back has no passport number');
  assert.equal(result.details.passport_consistent, true);
});

test('runDocumentConsistencyChecks fails when front visual and MRZ disagree (intra-front fallback)', () => {
  const result = runDocumentConsistencyChecks({
    front: {
      passport_number: 'A1111111',      // visual
      mrz_line2:       'B2222222<7IND8207089F2503228'  // MRZ has different number
    },
    back: {},  // no back passport number
    passport_number: 'A1111111'
  });

  assert.equal(result.front_back_consistency_valid, false);
  assert.equal(result.details.cross_page_check_performed, false);
  assert.equal(result.details.passport_consistent, false);
});

// ── True cross-page check (back page has passport number) ─────────────────────

test('cross-page: passes when back passport matches front MRZ', () => {
  const result = runDocumentConsistencyChecks({
    front: {
      passport_number: 'A1234567',
      mrz_line2:       'A12345670IND9001011M3001011<<<<<<<<<<<<<6'
    },
    back: {
      passport_number: 'A1234567',      // back page prints the same passport number
      file_number:     'MAA1234567890',
      address_block:   '12 Main St, Chennai PIN 600040, Tamil Nadu'
    },
    passport_number: 'A1234567'
  });

  assert.equal(result.front_back_consistency_valid, true);
  assert.equal(result.details.cross_page_check_performed, true,
    'should perform true cross-page check when back has passport number');
  assert.equal(result.details.back_passport, 'A1234567');
  assert.equal(result.details.passport_consistent, true);
});

test('cross-page: FAILS when back passport does not match front MRZ (different passports)', () => {
  // This is the exact scenario the user reported: front from passport A,
  // back from passport B.  Previously this silently passed.
  const result = runDocumentConsistencyChecks({
    front: {
      passport_number: 'A1234567',                              // Passport A
      mrz_line2:       'A12345670IND9001011M3001011<<<<<<<<<<<<<6'  // Passport A MRZ
    },
    back: {
      passport_number: 'B9999999',  // Passport B — completely different person
      file_number:     'MAA9999999999',
      address_block:   'Chennai PIN 600040, Tamil Nadu'
    },
    passport_number: 'A1234567'
  });

  assert.equal(result.front_back_consistency_valid, false,
    'MUST fail when back page is from a different passport');
  assert.equal(result.details.cross_page_check_performed, true);
  assert.equal(result.details.back_passport,     'B9999999');
  assert.equal(result.details.front_mrz_passport, 'A12345670'); // MRZ field is 9 chars: A1234567 + check digit 0
  assert.equal(result.details.passport_consistent, false);
});

test('cross-page: FAILS when back has passport number but front OCR missed it entirely', () => {
  // Back page has a number but the front produced nothing — suspicious asymmetry.
  const result = runDocumentConsistencyChecks({
    front: {},  // OCR produced no passport number on the front
    back: {
      passport_number: 'A1234567',
      file_number:     'MAA1234567890',
      address_block:   'Chennai PIN 600040'
    }
  });

  assert.equal(result.front_back_consistency_valid, false,
    'should fail when back has a number but front produced nothing');
  assert.equal(result.details.cross_page_check_performed, true);
  assert.equal(result.details.passport_consistent, false);
});

test('cross-page: tolerates 1-character OCR truncation on back passport number', () => {
  // OCR read 8 chars on the back instead of the 9-char MRZ passport field
  // (A12345670 → A1234567, trailing digit cut off).
  const result = runDocumentConsistencyChecks({
    front: {
      mrz_line2: 'A12345670IND9001011M3001011<<<<<<<<<<<<<6'
    },
    back: {
      passport_number: 'A1234567',  // 8 chars — OCR missed the trailing '0'
      file_number:     'MAA1234567890',
      address_block:   'Chennai PIN 600040, Tamil Nadu'
    }
  });

  // Tolerance: shorter is ≥7 chars and longer starts with shorter → soft pass.
  // frontMrz parsed from the MRZ: 'A12345670' (9 chars).
  // back OCR reads 'A1234567' (8 chars) — 1 char shorter, ≥7 chars → tolerated.
  assert.equal(result.details.cross_page_check_performed, true);
  assert.equal(result.details.passport_consistent, true,
    'should tolerate 1-char OCR truncation same as mrz_visual_passport_match');
});

// ── RPO consistency ───────────────────────────────────────────────────────────

test('RPO: fails when file number RPO conflicts with address region', () => {
  const result = runDocumentConsistencyChecks({
    front: { passport_number: 'A1234567', mrz_line2: 'A12345670IND9001011M3001011<<<<<<<<<<<<<6' },
    back: {
      file_number:    'MAA1234567890',   // RPO = MAA (Chennai region)
      address_block:  '45 MG Road, Bengaluru PIN 560001, Karnataka, India'  // Bengaluru
    },
    passport_number: 'A1234567'
  });

  // RPO from file number (MAA = Chennai) does not match address (Bengaluru).
  assert.equal(result.details.rpo_consistent, false);
  assert.equal(result.front_back_consistency_valid, false);
});

test('passes when both passport and RPO are internally consistent', () => {
  const result = runDocumentConsistencyChecks({
    front: {
      passport_number: 'A1234567',
      mrz_line2:       'A12345670IND9001011M3001011<<<<<<<<<<<<<6'
    },
    back: {
      passport_number: 'A1234567',
      file_number:     'MAA1234567890',
      address_block:   'Chennai PIN 600040, Tamil Nadu, India'
    },
    passport_number: 'A1234567'
  });

  assert.equal(result.front_back_consistency_valid, true);
  assert.equal(result.details.cross_page_check_performed, true);
  assert.equal(result.details.passport_consistent, true);
  assert.equal(result.details.rpo_consistent, true);
});
