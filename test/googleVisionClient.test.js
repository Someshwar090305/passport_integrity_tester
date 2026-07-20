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
  const rawText = `P<INDA LEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<
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

test('normalizeGoogleVisionText extracts truncated MRZ line 2 (< 42 chars) after a P< header', () => {
  // Real-world case: OCR returned the numeric MRZ line truncated to 33 chars.
  // Previously the 42-char minimum caused the extraction to miss it entirely,
  // falling back to the alpha line and producing passport_number='PINDHALA'.
  const rawText = [
    'P<INDHALADY<<SHAILAJA<KUMARI<<<<<<<<<<<<<<<<',
    'K0037575<1IND7706105F2112080<<<<<',
    'Passport No. K0037575',
    'Date of Birth 10/06/1977',
    'Date of Expiry 08/12/2021'
  ].join('\n');

  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.mrz_line2, 'K0037575<1IND7706105F2112080<<<<<',
    'should pick up the 33-char truncated numeric MRZ line, not the alpha line');
  assert.equal(normalized.front.mrz_line1, 'P<INDHALADY<<SHAILAJA<KUMARI<<<<<<<<<<<<<<<<',
    'alpha line should still be correctly identified as line 1');
});
