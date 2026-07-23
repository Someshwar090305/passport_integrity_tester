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

test('normalizeGoogleVisionText extracts DOB from OCR noise like "dayate of Birth"', () => {
  const rawText = `P<INDALEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<
L898902C36IND7408122F1204159ZE184226B<<<<<10
Passport No. A1234567
dayate of Birth 12/08/1974
Date of Expiry 15/04/2012
File No. MAA1234567
Address No. 123, Chennai, Tamil Nadu 600089`;
  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.date_of_birth, '1974-08-12');
});

test('normalizeGoogleVisionText extracts expiry from OCR noise like "Oate of Expiry"', () => {
  const rawText = `P<INDALEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<
L898902C36IND7408122F1204159ZE184226B<<<<<10
Passport No. A1234567
Date of Birth 12/08/1974
Oate of Expiry 15/04/2012
File No. MAA1234567
Address No. 123, Chennai, Tamil Nadu 600089`;
  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.expiry_date, '2012-04-15');
});

test('normalizeGoogleVisionText extracts DOB from OCR label and date separated by extra lines', () => {
  const rawText = `P<INDALEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<
L898902C36IND7408122F1204159ZE184226B<<<<<10
Passport No. A1234567
जन्मतिथि / Date of Birtha
लिंग/ Sex
27/05/2001
Date of Expiry 15/04/2012
File No. MAA1234567
Address No. 123, Chennai, Tamil Nadu 600089`;
  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.visual_raw.date_of_birth, '2001-05-27');
  assert.equal(normalized.front.date_of_birth, '1974-08-12');
});

test('normalizeGoogleVisionText extracts DOB and expiry from OCR noise on split lines', () => {
  const rawText = `P<INDALEXANDER<<JOHN<<<<<<<<<<<<<<<<<<<<<<
L898902C36IND7408122F1204159ZE184226B<<<<<10
Passport No. A1234567
aph/Date of Birt
10/06/1977
wofte wh/Date of Expiry
08/12/2012
File No. A1234567
Address No. 123, Chennai, Tamil Nadu 600089`;
  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.visual_raw.date_of_birth, '1977-06-10');
  assert.equal(normalized.front.visual_raw.expiry_date, '2012-12-08');
  assert.equal(normalized.front.date_of_birth, '1974-08-12');
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

test('normalizeGoogleVisionText does not accept front text that looks like an MRZ line 2 but is actually the upper passport page body', () => {
  const rawText = [
    'भारत गणराज्य / REPUBLIC OF INDIA',
    'V/Nationality',
    'टाइप (Type',
    'कोड Code',
    'P',
    'IND',
    'भारतीय / INDIAN',
    'उपनाम / Surname',
    '/ Passport No.',
    'AR914664',
    'типти',
    'TACHAMBARA SESHADRI',
    'दिया गया नाम / Given Name(s)',
    'ESHWARAN',
    'जन्मतिथि / Date of Birth',
    '17/12/1977',
    'जन्म स्थान / Place of Birth',
    'CHENNAI, TAMIL NADU',
    'जारी करने का स्थान / Place of Issue',
    'CHENNAI',
    'जारी करने की तिथि / Date of issue',
    '26/05/2026',
    'समाप्ति की तिथि / Date of Expiry',
    '25/05/2036',
    'ACHALER',
    '17',
    'लिंग / Sex',
    'M',
    'ACHAM',
    'ZACHAMD',
    'TACH',
    '22701820',
    'AMBATA E',
    'SHADTU',
    'A-EESHAD',
    'WARNETA',
    '3070875',
    'CAMBA2',
    'ADRKTACH',
    'SHADRIN1711237',
    'BARA ESHWAL',
    '12/19771MA3070822',
    'WARANICHENNA',
    'JARA SESHAD',
    'NARANICHENNA',
    'RANICHENNA',
    'لمات',
    'MADA',
    '1A307',
    'P<INDTACHAMBARA<SESHADRI<<ESHWARAN<<<<<<<<<<'
  ].join('\n');

  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(normalized.front.mrz_line1, 'P<INDTACHAMBARA<SESHADRI<<ESHWARAN<<<<<<<<<<');
  assert.equal(normalized.front.mrz_line2, null);
  assert.equal(normalized.front.passport_number, 'AR914664');
});

test('normalizeGoogleVisionText: visual_raw.passport_number is null when visual field is partially obscured', () => {
  // Replicates the real-world tamper scenario: last 2 chars of the printed
  // passport number field are physically covered. OCR reads "C22033" (6 chars).
  // The MRZ is intact with "C2203304". Without MRZ-line stripping, the fallback
  // regex \b([A-Z][0-9]{7})\b would match C2203304 from the MRZ text, making
  // visual_raw.passport_number = "C2203304" — circular cross-check.
  // After MRZ stripping, "C22033" (6 chars) is too short for either pattern
  // → null, which correctly fails the mrz_visual_passport_match integrity check.
  const rawText = [
    'P<INDSANTHARAM<<VAITHEESWARAN<<<<<<<<<<<<<<<',
    'C2203304<6IND7410149M34091092076925493724<02',
    'Passport No.',
    'C22033',                   // ← only 6 chars visible (last 2 physically obscured)
    'Date of Birth 14/10/1974',
    'Date of Expiry 10/09/2034'
  ].join('\n');

  const normalized = normalizeGoogleVisionText(rawText);

  assert.equal(
    normalized.front.visual_raw.passport_number,
    null,
    'obscured visual field (C22033, 6 chars) must not fall back to MRZ text'
  );
  assert.equal(
    normalized.front.passport_number,
    'C2203304',
    'extracted_data passport_number is still MRZ-derived for accurate output'
  );
  assert.equal(
    normalized.front.visual_raw.date_of_birth,
    '1974-10-14',
    'unobscured DOB visual field still extracts correctly'
  );
});
