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

function extractIssueDate(text) {
  if (!text) return null;
  const match =
    text.match(/\bDate\s*of\s*Issue\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i) ||
    text.match(/\bIssue\s*Date\s*[:\-]?\s*([0-3]?\d[\/\-][01]?\d[\/\-]\d{4})\b/i);
  return normalizeDateString(match?.[1] || null);
}

function extractPlaceOfIssue(text) {
  if (!text) return null;
  const match = text.match(/\bPlace\s*of\s*Issue\s*[\n\r]*[:\-]?[\n\r]*\s*([A-Z\s]{3,30})\b/i);
  if (!match) return null;
  const city = match[1].split('\n')[0].trim().toUpperCase();
  return city || null;
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
 * Extracts the current passport number from the back (address) page.
 *
 * Indian passport numbers are always 8 characters, in one of two formats:
 *   - Legacy : 1 letter + 7 digits   (e.g. M7229450, C2203304)
 *   - Modern : 2 letters + 6 digits  (e.g. AG296600)
 *
 * Two sources are tried in order:
 *
 * 1. Labeled — "Passport No. XXXXXXXX" (found on some passport layouts)
 *    Negative lookbehind excludes "Old Passport No."
 *
 * 2. Barcode-adjacent (unlabeled) — the current passport number is printed
 *    as a plain string just below the barcode in the top-right corner.
 *    Google Vision OCR surfaces it as a standalone line, often just after
 *    the "Address" label block.
 *
 *    To avoid false positives we first surgically remove the entire
 *    "Old Passport No." block (label + number value + date + city),
 *    then match the FIRST standalone passport-format token remaining.
 */
function extractPassportNumberFromBackPage(text) {
  if (!text) return null;

  // ── Pattern 1: Labeled (but NOT "Old Passport No.") ──────────────────────
  // Matches both legacy (1-letter) and modern (2-letter) formats.
  const labeledMatch =
    text.match(/(?<!Old\s+)\bPassport\s*(?:No|Number)\.?\s*[:\-]?\s*([A-Z]{1,2}[0-9]{6,7})\b/i) ||
    text.match(/\bP\.?\s*No\.?\s*[:\-]?\s*([A-Z]{1,2}[0-9]{6,7})\b/i);
  if (labeledMatch) return String(labeledMatch[1]).toUpperCase();

  // ── Pattern 2: Unlabeled barcode-adjacent ────────────────────────────────
  // Strip the ENTIRE "Old Passport No." block before searching.
  // The block structure is:
  //   "... Old Passport No. with Date and Place of Issue\n"
  //   "<passport-number>\n"          ← must remove this too
  //   "<date dd/mm/yyyy>\n"          ← and this
  //   "<city name>\n"                ← and this
  //
  // Also strip the File No. line (always 2+ letters + 8+ digits).
  const cleaned = text
    .replace(
      /Old\s+Passport\s*(?:No|Number)[^\n]*\n(?:[A-Z]{1,2}[0-9]{6,7}\n)?(?:\d{2}\/\d{2}\/\d{4}\n)?(?:[A-Z][A-Z\s]{1,20}\n)?/gi,
      ''
    )
    .replace(/(?:पुराने[^\n]*\n)/g, '')  // strip Hindi "Old Passport" label if present
    .replace(/File\s*(?:No|Number)\.?[^\n]*/gi, '');

  // Find the first standalone passport-format number (1–2 letters + 6–7 digits).
  const standaloneMatch = cleaned.match(/(?:^|\n)\s*([A-Z]{1,2}[0-9]{6,7})\s*(?:\n|$)/);
  if (standaloneMatch) return String(standaloneMatch[1]).toUpperCase();

  // ── Pattern 3: OCR confusable recovery ────────────────────────────────────
  // Google Vision commonly misreads passport-number leading letters as digits:
  //   Z → 2  (most common — same shape)
  //   O → 0
  //   I → 1
  // When a standalone 8-char token starts with 2/0/1 followed by 7 digits, try
  // substituting back to the likely letter. The corrected value is returned only
  // if it matches a plausible passport-number pattern.
  const confusableMap = { '2': 'Z', '0': 'O', '1': 'I' };
  const confusableMatch = cleaned.match(/(?:^|\n)\s*([201][0-9]{7})\s*(?:\n|$)/);
  if (confusableMatch) {
    const raw = confusableMatch[1];
    const corrected = (confusableMap[raw[0]] || raw[0]) + raw.slice(1);
    if (/^[A-Z][0-9]{7}$/.test(corrected)) {
      return corrected;
    }
  }

  return null;
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
  const issueDate = extractIssueDate(normalized);
  const placeOfIssue = extractPlaceOfIssue(normalized);

  return {
    front: {
      mrz_line1: mrzLine1,
      mrz_line2: mrzLine2,
      date_of_birth: dob,
      passport_number: passportNumber,
      expiry_date: expiry,
      date_of_issue: issueDate,
      place_of_issue: placeOfIssue
    },
    passport_number: passportNumber,
    date_of_birth: dob,
    expiry_date: expiry,
    date_of_issue: issueDate,
    place_of_issue: placeOfIssue,
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
    date_of_issue:   pick(frontResult.front.date_of_issue, null),
    place_of_issue:  pick(frontResult.front.place_of_issue, null),
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
