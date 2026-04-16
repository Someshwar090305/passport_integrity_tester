const WEIGHTS = [7, 3, 1];

function charValue(char) {
  if (char >= '0' && char <= '9') return Number(char);
  if (char >= 'A' && char <= 'Z') return char.charCodeAt(0) - 55;
  if (char === '<') return 0;
  return 0;
}

function computeChecksum(segment) {
  return segment
    .split('')
    .reduce((acc, char, idx) => acc + charValue(char) * WEIGHTS[idx % WEIGHTS.length], 0) % 10;
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

  return {
    passportNumber: normalized.slice(0, 9).replace(/</g, ''),
    dateOfBirthRaw: normalized.slice(13, 19),
    expiryDateRaw: normalized.slice(21, 27)
  };
}
