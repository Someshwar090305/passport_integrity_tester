const WEIGHTS = [7, 3, 1];

function charValue(char) {
  if (char >= '0' && char <= '9') return Number(char);
  if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 55;
  if (char === '<') return 0;
  return 0;
}

export function computeChecksum(segment) {
  return segment
    .split('')
    .reduce((acc, char, idx) => acc + charValue(char) * WEIGHTS[idx % WEIGHTS.length], 0) % 10;
}

function cleanMrzLine(raw) {
  return String(raw || '').replace(/[^A-Z0-9<]/gi, '').toUpperCase().trim();
}

export function parseMrzLine1(mrzLine1 = '') {
  const normalized = cleanMrzLine(mrzLine1);
  if (!normalized.startsWith('P<') || normalized.length < 39) {
    return null;
  }

  const padded = normalized.padEnd(44, '<').slice(0, 44);
  const issuingCountry = padded.slice(2, 5);
  const namesPart = padded.slice(5, 44);
  const nameParts = namesPart.split('<<');
  const surname = (nameParts[0] || '').replace(/</g, ' ').trim();
  const givenNames = (nameParts[1] || '').replace(/</g, ' ').trim();

  return {
    documentType: normalized[0],
    issuingCountry,
    surname: surname || null,
    givenNames: givenNames || null
  };
}

export function validateMrzCompositeCheck(mrzLine2 = '') {
  const normalized = cleanMrzLine(mrzLine2);
  if (normalized.length < 44) {
    return { valid: false, applicable: false };
  }

  const compositeSegment =
    normalized.slice(0, 10) +
    normalized.slice(13, 20) +
    normalized.slice(21, 28) +
    normalized.slice(28, 43);
  const expected = Number(normalized[43]);
  const computed = computeChecksum(compositeSegment);

  return {
    valid: computed === expected,
    applicable: true
  };
}

export function validateMrzChecksums(mrzLine2 = '') {
  const normalized = String(mrzLine2).toUpperCase().trim();
  // Some OCR outputs truncate MRZ line 2 (e.g. missing trailing filler chars),
  // but we can still validate passport/DOB/expiry checksums as long as
  // indexes required by those fields exist.
  const MIN_MRZ_LINE2_LENGTH = 28; // up to expiry check digit at index 27
  if (normalized.length < MIN_MRZ_LINE2_LENGTH) {
    return {
      valid: false,
      details: {
        passportNumber: false,
        dateOfBirth: false,
        expiryDate: false
      }
    };
  }

  const passportSegment = normalized.slice(0, 9);
  const passportCheck = Number(normalized[9]);
  const dobSegment = normalized.slice(13, 19);
  const dobCheck = Number(normalized[19]);
  const expirySegment = normalized.slice(21, 27);
  const expiryCheck = Number(normalized[27]);

  const passportNumber = computeChecksum(passportSegment) === passportCheck;
  const dateOfBirth = computeChecksum(dobSegment) === dobCheck;
  const expiryDate = computeChecksum(expirySegment) === expiryCheck;

  return {
    valid: passportNumber && dateOfBirth && expiryDate,
    details: {
      passportNumber,
      dateOfBirth,
      expiryDate
    }
  };
}

export function parseMrzLine2(mrzLine2 = '') {
  const normalized = String(mrzLine2).toUpperCase().trim();
  const MIN_MRZ_LINE2_LENGTH = 28; // up to expiry check digit at index 27
  if (normalized.length < MIN_MRZ_LINE2_LENGTH) {
    return null;
  }

  // Optional data field (positions 28-41) — India encodes the numeric portion
  // of the application file number here (without the RPO letter prefix).
  // Strip filler characters (<) and trim to get the raw numeric string.
  const optionalDataRaw = normalized.length >= 42
    ? normalized.slice(28, 42).replace(/</g, '').trim()
    : null;

  return {
    passportNumber: normalized.slice(0, 9).replace(/</g, ''),
    nationality: normalized.slice(10, 13).replace(/</g, '') || null,
    dateOfBirthRaw: normalized.slice(13, 19),
    sex: normalized[20] || null,
    expiryDateRaw: normalized.slice(21, 27),
    // Numeric portion of the Indian file number encoded in the MRZ optional
    // data field. Empty string normalised to null.
    optionalData: optionalDataRaw || null
  };
}
