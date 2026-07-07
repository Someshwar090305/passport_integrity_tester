import vision from '@google-cloud/vision';
import { parseMrzLine2, validateMrzChecksums } from '../validators/mrzChecksum.js';
import { pick, yyMmDdToIso, cleanMrzLine, normalizeDateString } from '../utils/helpers.js';

const credentialPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_KEYFILE_JSON;

let client;
function getClient() {
  if (!client) {
    client = credentialPath
      ? new vision.ImageAnnotatorClient({ keyFilename: credentialPath })
      : new vision.ImageAnnotatorClient();
  }
  return client;
}

function normalizeText(raw) {
  return String(raw || '').replace(/\r/g, '\n').replace(/[\t\u00A0]+/g, ' ').trim();
}

function extractMrzLine1(text) {
  if (!text) return null;
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => cleanMrzLine(line))
    .filter((line) => line.length >= 10);

  const line1 = lines.find((line) => line.startsWith('P<') && line.length >= 44);
  if (line1) return line1;

  const match = cleanMrzLine(text).match(/P<[A-Z]{3}[A-Z<]{30,}/);
  return match?.[0]?.slice(0, 44) || null;
}

function extractMrzLine2(text) {
  if (!text) return null;
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => cleanMrzLine(line))
    .filter((line) => line.length >= 10);

  const mrzLines = lines.filter((line) => /^[A-Z0-9<]{42,44}$/.test(line));
  const validMrz = mrzLines.find((line) => validateMrzChecksums(line).valid);
  if (validMrz) return validMrz;

  const headerIndex = lines.findIndex((line) => line.startsWith('P<'));
  if (headerIndex !== -1 && lines[headerIndex + 1]) {
    const candidate = cleanMrzLine(lines[headerIndex + 1]);
    if (/^[A-Z0-9<]{42,44}$/.test(candidate)) {
      return candidate;
    }
  }

  if (mrzLines.length > 0) return mrzLines[0];

  const candidates = Array.from(new Set(cleanMrzLine(text).match(/[A-Z0-9<]{42,44}/g) || []));
  return candidates[0] || null;
}

function extractPassportNumber(text) {
  if (!text) return null;
  const match =
    text.match(/\bPassport\s*No\.?\s*([A-Z0-9]{7,9})\b/i) ||
    text.match(/\b([A-Z][0-9]{7})\b/);
  return match?.[1] || null;
}

function extractDateOfBirth(text) {
  if (!text) return null;
  const match =
    text.match(/\bDate\s*of\s*Birth\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i) ||
    text.match(/\bDOB\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i) ||
    text.match(/\bजन्मतिथि\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i);
  return normalizeDateString(match?.[1] || null);
}

function extractExpiryDate(text) {
  if (!text) return null;
  const match =
    text.match(/\bDate\s*of\s*Expiry\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i) ||
    text.match(/\bExpiry\s*Date\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i) ||
    text.match(/\bValid\s*Until\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i) ||
    text.match(/\bEXP\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i);
  return normalizeDateString(match?.[1] || null);
}

function extractFileNumber(text) {
  if (!text) return null;
  const match =
    text.match(/\bFile\s*No\.?\s*[:\-]?\s*([A-Z0-9]{6,20})\b/i) ||
    text.match(/\bApplication\s*No\.?\s*[:\-]?\s*([A-Z0-9]{6,20})\b/i) ||
    text.match(/\b([A-Z]{2,4}[0-9]{8,})\b/);
  return match?.[1] || null;
}

/**
 * Extracts the passport number printed on the back (address) page of an
 * Indian passport. The pattern requires the "Passport No." label to avoid
 * false positives from the file number or other alpha-numeric strings.
 *
 * Deliberately uses stricter patterns than extractPassportNumber (front page)
 * to minimise false positives from OCR noise on the back page.
 */
function extractPassportNumberFromBackPage(text) {
  if (!text) return null;
  const match =
    text.match(/\bPassport\s*(?:No|Number)\.?\s*[:\-]?\s*([A-Z][0-9]{7,8})\b/i) ||
    text.match(/\bP\.?\s*No\.?\s*[:\-]?\s*([A-Z][0-9]{7,8})\b/i);
  return match ? String(match[1]).toUpperCase() : null;
}

function extractAddressBlock(text) {
  if (!text) return null;
  const normalized = text.replace(/\n{2,}/g, '\n').trim();
  const lines = normalized.split(/\n/).map((line) => line.trim()).filter(Boolean);

  const addressIndex = lines.findIndex((line) => /\bAddress\b/i.test(line));
  if (addressIndex !== -1) {
    const block = lines.slice(addressIndex, addressIndex + 5).join(', ');
    return block || null;
  }

  const pinIndex = lines.findIndex((line) => /\bPIN\b[:\s]*\d{6}|\b\d{6}\b/.test(line));
  if (pinIndex !== -1) {
    return lines.slice(Math.max(0, pinIndex - 2), pinIndex + 2).join(', ');
  }

  const candidate = lines.find(
    (line) => /\b(?:Village|City|State|District|Pin|PIN|India)\b/i.test(line) && line.length > 20
  );
  return candidate || null;
}

/**
 * Full normalisation of front-page OCR text.
 * Extracts MRZ lines, passport number, DOB, and expiry.
 */
function normalizeFrontPageText(text) {
  const normalized = normalizeText(text);
  const mrzLine1 = extractMrzLine1(normalized);
  const mrzLine2 = extractMrzLine2(normalized);
  const parsedMrz = parseMrzLine2(mrzLine2 || '');
  const mrzPassportNumber = parsedMrz?.passportNumber || null;
  const mrzDob    = yyMmDdToIso(parsedMrz?.dateOfBirthRaw || '');
  const mrzExpiry = yyMmDdToIso(parsedMrz?.expiryDateRaw  || '');

  const passportNumber = pick(mrzPassportNumber, extractPassportNumber(normalized));
  const dob    = pick(mrzDob,    extractDateOfBirth(normalized));
  const expiry = pick(mrzExpiry, extractExpiryDate(normalized));

  return {
    front: {
      mrz_line1: mrzLine1,
      mrz_line2: mrzLine2,
      date_of_birth: dob,
      passport_number: passportNumber,
      expiry_date: expiry
    },
    passport_number: passportNumber,
    date_of_birth: dob,
    expiry_date: expiry,
    raw: { text: normalized }
  };
}

/**
 * Back-page normalisation — deliberately does NOT attempt MRZ extraction.
 * The Indian passport back page never contains an MRZ; running the MRZ
 * extractor on it risks false positives from OCR noise that happens to
 * look like a 42-44 character alpha-numeric string.
 */
function normalizeBackPageText(text) {
  const normalized = normalizeText(text);
  const fileNumber   = extractFileNumber(normalized);
  const addressBlock = extractAddressBlock(normalized);
  // The back page prints the passport number under a "Passport No." label
  // on most Indian passports. Extracted here so it can be used as the
  // cross-page anchor in documentConsistency checks.
  const passportNumber = extractPassportNumberFromBackPage(normalized);

  return {
    back: {
      file_number:     fileNumber,
      address_block:   addressBlock,
      passport_number: passportNumber   // null when not printed / not readable
    },
    file_number: fileNumber,
    address:     addressBlock,
    raw: { text: normalized }
  };
}

/** @deprecated Kept for backward-compat with existing tests; use the page-specific functions. */
export function normalizeGoogleVisionText(rawText) {
  const frontResult = normalizeFrontPageText(rawText);
  // Run the text through the back-page extractor as well so legacy callers
  // still get file_number and address from the same call.
  const backResult = normalizeBackPageText(rawText);

  return {
    ...frontResult,
    back: backResult.back,
    file_number: frontResult.file_number || backResult.file_number,
    address: frontResult.raw.text ? null : backResult.address  // front text won't have an address
  };
}

async function detectTextFromImage(imageEncoded) {
  // imageEncoded.dataBase64 is already a base64 string — pass it directly to
  // the Vision API. The previous Buffer.from(..., 'base64').toString('base64')
  // round-trip was a wasted allocation on every image.
  const [result] = await getClient().documentTextDetection({
    image: {
      content: imageEncoded.dataBase64
    }
  });

  const text = result.fullTextAnnotation?.text || '';

  return { text, raw: { text } };
}

export async function extractPassportData(frontImageEncoded, backImageEncoded) {
  const [frontResponse, backResponse] = await Promise.all([
    detectTextFromImage(frontImageEncoded),
    detectTextFromImage(backImageEncoded)
  ]);

  // Front page: full extraction (MRZ + passport fields).
  const frontResult = normalizeFrontPageText(frontResponse.text);
  // Back page: file number + address ONLY — no MRZ extraction.
  const backResult  = normalizeBackPageText(backResponse.text);

  return {
    front: {
      mrz_line1: frontResult.front.mrz_line1 || null,
      ...frontResult.front
    },
    back: {
      ...backResult.back
    },
    passport_number: pick(frontResult.passport_number, null),
    date_of_birth:   pick(frontResult.date_of_birth,   null),
    expiry_date:     pick(frontResult.expiry_date,      null),
    file_number:     pick(backResult.file_number,       null),
    address:         pick(backResult.address,           null),
    raw: {
      google_vision: {
        front: frontResponse.raw.text,
        back:  backResponse.raw.text
      }
    }
  };
}
