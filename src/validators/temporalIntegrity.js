function parseIsoDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const date = new Date(`${str}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function runTemporalIntegrityChecks(extractedData) {
  const dob = parseIsoDate(extractedData?.date_of_birth);
  const expiry = parseIsoDate(extractedData?.expiry_date);
  const today = todayUtc();

  const minDob = new Date(Date.UTC(1900, 0, 1));
  const maxAgeYears = 120;
  const maxDob = new Date(today);
  maxDob.setUTCFullYear(maxDob.getUTCFullYear() - maxAgeYears);

  const dobPlausible = dob ? dob >= minDob && dob <= today && dob >= maxDob : false;
  const documentNotExpired = expiry ? expiry >= today : false;
  const expiryAfterDob = dob && expiry ? expiry > dob : false;

  return {
    dob_plausible: dobPlausible,
    document_not_expired: documentNotExpired,
    expiry_after_dob: expiryAfterDob,
    details: {
      date_of_birth: extractedData?.date_of_birth || null,
      expiry_date: extractedData?.expiry_date || null,
      evaluated_on: today.toISOString().slice(0, 10)
    }
  };
}
