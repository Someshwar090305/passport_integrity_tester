import vision from '@google-cloud/vision';
import { parseMrzLine2, validateMrzChecksums } from '../validators/mrzChecksum.js';

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

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeDateString(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const embeddedIso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (embeddedIso) return embeddedIso[1];
  if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(value)) {
    const [dd, mm, yyyy] = value.split(/[-/]/);
    return `${yyyy}-${mm}-${dd}`;
  }
  const embeddedDmy = value.match(/\b([0-3]?\d)[-/]([01]?\d)[-/](\d{4})\b/);
  if (embeddedDmy) {
    const dd = embeddedDmy[1].padStart(2, '0');
    const mm = embeddedDmy[2].padStart(2, '0');
    const yyyy = embeddedDmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function normalizeText(raw) {
  return String(raw || '').replace(/\r/g, '\n').replace(/[\t\u00A0]+/g, ' ').trim();
}

function cleanMrzLine(raw) {
  return String(raw || '').replace(/[^A-Z0-9<]/gi, '').toUpperCase().trim();
}

function yyMmDdToIso(value) {
  if (!/^[0-9]{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = value.slice(2, 4);
  const dd = value.slice(4, 6);
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
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

  const candidate = lines.find((line) => /\b(?:Village|City|State|District|Pin|PIN|India)\b/i.test(line) && line.length > 20);
  return candidate || null;
}

function extractVisualDobFromText(text) {
  return extractDateOfBirth(text);
}

function normalizeGoogleVisionText(rawText) {
  const text = normalizeText(rawText);
  const mrzLine2 = extractMrzLine2(text);
  const parsedMrz = parseMrzLine2(mrzLine2 || '');
  const mrzPassportNumber = parsedMrz?.passportNumber || null;
  const mrzDob = yyMmDdToIso(parsedMrz?.dateOfBirthRaw || '');
  const mrzExpiry = yyMmDdToIso(parsedMrz?.expiryDateRaw || '');
  const passportNumber = pick(mrzPassportNumber, extractPassportNumber(text));
  const dob = pick(mrzDob, extractDateOfBirth(text));
  const expiry = pick(mrzExpiry, extractExpiryDate(text));
  const fileNumber = extractFileNumber(text);
  const addressBlock = extractAddressBlock(text);

  return {
    front: {
      mrz_line2: mrzLine2,
      date_of_birth: dob,
      passport_number: passportNumber,
      expiry_date: expiry
    },
    back: {
      file_number: fileNumber,
      address_block: addressBlock
    },
    passport_number: passportNumber,
    date_of_birth: dob,
    expiry_date: expiry,
    file_number: fileNumber,
    address: addressBlock,
    raw: {
      text
    }
  };
}

async function detectTextFromImage(imageEncoded) {
  const buffer = Buffer.from(imageEncoded.dataBase64, 'base64');
  const [result] = await getClient().documentTextDetection({
    image: {
      content: buffer.toString('base64')
    }
  });
  return result.fullTextAnnotation?.text || '';
}

export async function extractPassportData(frontImageEncoded, backImageEncoded) {
  const [frontText, backText] = await Promise.all([
    detectTextFromImage(frontImageEncoded),
    detectTextFromImage(backImageEncoded)
  ]);

  const frontResult = normalizeGoogleVisionText(frontText);
  const backResult = normalizeGoogleVisionText(backText);

  return {
    front: {
      ...frontResult.front
    },
    back: {
      ...backResult.back
    },
    passport_number: pick(frontResult.passport_number, backResult.passport_number),
    date_of_birth: pick(frontResult.date_of_birth, backResult.date_of_birth),
    expiry_date: pick(frontResult.expiry_date, backResult.expiry_date),
    file_number: pick(frontResult.file_number, backResult.file_number),
    address: pick(frontResult.address, backResult.address),
    raw: {
  front: frontResult.raw,
  back: backResult.raw,
  frontText: frontText,
  backText: backText
}
  };
}

export { normalizeGoogleVisionText };
