import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGoogleVisionText } from '../src/providers/googleVisionClient.js';

test('normalizeGoogleVisionText extracts MRZ and passport fields from OCR text', () => {
  const rawText = `P<INDALEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<\nL898902C36IND7408122F1204159ZE184226B<<<<<10\nPassport No. A1234567\nDate of Birth 12/08/1974\nDate of Expiry 15/04/2012\nFile No. MAA1234567\nAddress No. 123, Chennai, Tamil Nadu 600089`;
  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.mrz_line2, 'L898902C36IND7408122F1204159ZE184226B<<<<<10');
  assert.equal(normalized.front.passport_number, 'L898902C3');
  assert.equal(normalized.front.date_of_birth, '1974-08-12');
  assert.equal(normalized.front.expiry_date, '2012-04-15');
  assert.equal(normalized.back.file_number, 'MAA1234567');
  assert.equal(normalized.back.address_block.includes('Chennai'), true);
});

test('normalizeGoogleVisionText prefers MRZ-derived passport fields when raw text contains ambiguous values', () => {
  const rawText = `P<INDALEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<
L898902C36IND7408122F1204159ZE184226B<<<<<10
Passport No. A1234567
DOB 12/08/1974
EXP 15/04/2012
Application No. ABC1234567
Address No. 123, Chennai, Tamil Nadu 600089`;
  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.mrz_line2, 'L898902C36IND7408122F1204159ZE184226B<<<<<10');
  assert.equal(normalized.front.passport_number, 'L898902C3');
  assert.equal(normalized.front.date_of_birth, '1974-08-12');
  assert.equal(normalized.front.expiry_date, '2012-04-15');
});
