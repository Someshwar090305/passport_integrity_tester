function yyMmDdToIso(value) {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2));
  const mm = value.slice(2, 4);
  const dd = value.slice(4, 6);
  const year = yy >= 50 ? 1900 + yy : 2000 + yy;
  return `${year}-${mm}-${dd}`;
}

function normalizeDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const embeddedIso = str.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (embeddedIso) return embeddedIso[1];
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const [dd, mm, yyyy] = str.split('/');
    return `${yyyy}-${mm}-${dd}`;
  }
  const embeddedDmy = str.match(/\b([0-3]?\d)\/([01]?\d)\/(\d{4})\b/);
  if (embeddedDmy) {
    const dd = embeddedDmy[1].padStart(2, '0');
    const mm = embeddedDmy[2].padStart(2, '0');
    const yyyy = embeddedDmy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  if (/^\d{6}$/.test(str)) return yyMmDdToIso(str);
  return null;
}

export function validateVisualMrzDobMatch(mrzDobRaw, visualDobRaw) {
  const mrzDob = normalizeDate(mrzDobRaw);
  const visualDob = normalizeDate(visualDobRaw);
  if (!mrzDob || !visualDob) return false;
  return mrzDob === visualDob;
}
