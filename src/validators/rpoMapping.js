const RPO_REGION_MAP = {
  // North
  DEL: ['DELHI', 'NEW DELHI'],
  CHD: ['CHANDIGARH', 'PUNJAB', 'HARYANA', 'HIMACHAL PRADESH'],
  JMU: ['JAMMU', 'JAMMU AND KASHMIR', 'JAMMU & KASHMIR'],
  SXR: ['SRINAGAR', 'KASHMIR'],
  LGH: ['LUDHIANA', 'PUNJAB'],
  JLR: ['JALANDHAR'],
  LKO: ['LUCKNOW', 'UTTAR PRADESH'],
  AGR: ['AGRA'],
  BAR: ['BAREILLY'],
  DRD: ['DEHRADUN', 'UTTARAKHAND'],
  DLH: ['GHAZIABAD', 'NOIDA'],
  // East
  KOL: ['KOLKATA', 'WEST BENGAL'],
  BHU: ['BHUBANESWAR', 'ODISHA'],
  GUW: ['GUWAHATI', 'ASSAM'],
  PAT: ['PATNA', 'BIHAR'],
  RAN: ['RANCHI', 'JHARKHAND'],
  // North-East (previously missing)
  IMP: ['IMPHAL', 'MANIPUR'],
  SHL: ['SHILLONG', 'MEGHALAYA'],
  AIZ: ['AIZAWL', 'MIZORAM'],
  KOH: ['KOHIMA', 'NAGALAND'],
  AGT: ['AGARTALA', 'TRIPURA'],
  ITN: ['ITANAGAR', 'ARUNACHAL PRADESH'],
  GNK: ['GANGTOK', 'SIKKIM'],
  // West
  BOM: ['MUMBAI', 'MAHARASHTRA'],
  PNQ: ['PUNE'],
  NAG: ['NAGPUR'],
  AMD: ['AHMEDABAD', 'GUJARAT'],
  SRT: ['SURAT'],
  RPR: ['RAIPUR', 'CHHATTISGARH'],
  BPL: ['BHOPAL', 'MADHYA PRADESH'],
  IDR: ['INDORE'],
  // South
  MAA: ['CHENNAI', 'TAMIL NADU', 'MADRAS'],  // MADRAS is the pre-1996 name
  BLR: ['BENGALURU', 'BANGALORE', 'KARNATAKA'],
  HYD: ['HYDERABAD', 'TELANGANA'],
  COK: ['KOCHI', 'COCHIN', 'KERALA'],
  TRV: ['THIRUVANANTHAPURAM', 'TRIVANDRUM'],
  MNG: ['MANGALURU', 'MANGALORE'],
  MDU: ['MADURAI'],
  TRZ: ['TIRUCHIRAPPALLI', 'TRICHY'],
  MYQ: ['MYSURU', 'MYSORE'],
  VGA: ['VIJAYAWADA', 'ANDHRA PRADESH'],
  VTZ: ['VISAKHAPATNAM', 'VIZAG'],
  // Others
  JAI: ['JAIPUR', 'RAJASTHAN'],
  JDH: ['JODHPUR'],
  GOI: ['GOA', 'PANAJI']
};


const RPO_PREFIX_ALIAS_MAP = {
  // 2-letter shorthand aliases (observed in file numbers)
  MA: 'MAA', // MA207... → RPO Chennai
  BO: 'BOM', // BO... → RPO Mumbai
  DE: 'DEL',
  BL: 'BLR',
  HY: 'HYD',
  KO: 'KOL',
  // Pre-2014 / old-city-name 3-letter aliases → normalise to current code.
  // These appear in file numbers of passports issued before city renames.
  MAS: 'MAA', // Madras → Chennai
  CAL: 'KOL', // Calcutta → Kolkata
  // BOM is already in RPO_REGION_MAP, so no alias needed
};

const STATE_ABBREVIATIONS = {
  TN: 'TAMIL NADU',
  KA: 'KARNATAKA',
  AP: 'ANDHRA PRADESH',
  TS: 'TELANGANA',
  KL: 'KERALA',
  MH: 'MAHARASHTRA',
  DL: 'DELHI',
  GJ: 'GUJARAT',
  OR: 'ODISHA',
  PB: 'PUNJAB',
  RJ: 'RAJASTHAN',
  UP: 'UTTAR PRADESH',
  WB: 'WEST BENGAL',
  BR: 'BIHAR'
};

function normalizeStateName(raw) {
  const state = String(raw || '').trim().toUpperCase();
  return STATE_ABBREVIATIONS[state] || state;
}

export function extractRpoCode(fileNumber = '') {
  const normalized = String(fileNumber).toUpperCase().trim();

  // Try 3-letter prefix first (most file numbers start with 3 letters).
  const threeLetter = normalized.match(/^[A-Z]{3}(?=[A-Z0-9])/);
  if (threeLetter) {
    const prefix = threeLetter[0];
    // Check alias map first (e.g. MAS → MAA, CAL → KOL)
    if (RPO_PREFIX_ALIAS_MAP[prefix]) return RPO_PREFIX_ALIAS_MAP[prefix];
    // Then check if it is already a canonical code
    if (RPO_REGION_MAP[prefix]) return prefix;
  }

  // Fall back to 2-letter prefix alias (e.g. MA → MAA, BO → BOM)
  const twoLetter = normalized.match(/^[A-Z]{2}(?=\d)/);
  if (!twoLetter) return null;
  return RPO_PREFIX_ALIAS_MAP[twoLetter[0]] || null;
}

export function parseAddressBlock(addressText = '') {
  const raw = String(addressText || '');
  const compact = raw.replace(/\s+/g, ' ').trim();
  // Match 6 consecutive digits (standard) OR 3+space+3 (OCR space-split, e.g. "600 024").
  const pinMatch = compact.match(/\b(?:PIN\s*[:\-]?\s*)?(\d{6})\b/i) ||
    compact.match(/\b(\d{3})\s(\d{3})\b/);
  const pinCode = pinMatch
    ? (pinMatch[2] ? pinMatch[1] + pinMatch[2] : pinMatch[1])  // join space-split
    : null;

  // Normalize key separators around PIN and commas to improve regex extraction.
  const normalized = compact
    .replace(/\bPIN\s*[:\-]?\s*(\d{6})\b/gi, ' PIN $1 ')
    .replace(/\b(\d{3})\s(\d{3})\b/g, '$1$2')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strong pattern for OCR strings like:
  // "... ANNA NAGAR, CHENNAI PIN 600040, TAMIL NADU, INDIA"
  const pinAnchored = normalized.match(
    /,\s*([A-Za-z .'-]+?)\s*,?\s*PIN\s+\d{6}\s*,\s*([A-Za-z .'-]+?)\s*(?:,|$)/i
  );
  if (pinAnchored) {
    return {
      pin_code: pinCode,
      city: pinAnchored[1].trim().toUpperCase(),
      state: normalizeStateName(pinAnchored[2].trim())
    };
  }

  const cityStatePatterns = [
    /\b([A-Za-z .'-]+)\s*\d{6}\s*([A-Za-z]{2})\b/i,
    /,\s*([A-Za-z .'-]+)\s*\d{6}\s*([A-Za-z]{2})\b/i,
    /\b([A-Za-z .'-]+)\s*,\s*([A-Za-z .'-]+)\s*\d{6}\s*([A-Za-z]{2})\b/i,
    /,\s*([A-Za-z .'-]+)\s*,\s*([A-Za-z .'-]+)\s*(?:PIN\s*)?\d{6}\b/i,
    /\b([A-Za-z .'-]+)\s*,\s*([A-Za-z .'-]+)\s*(?:PIN\s*)?\d{6}\b/i,
    /,\s*([A-Za-z .'-]+)\s*(?:PIN\s*)?\d{6}\b/i
  ];

  let city = null;
  let state = null;
  for (const pattern of cityStatePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      if (match.length === 3) {
        city = match[1].trim();
        state = match[2].trim();
      } else if (match.length === 4) {
        city = match[1].trim();
        state = match[3].trim();
      }
      break;
    }
  }

  // Fallback: infer city from "..., CITY PIN 123456, STATE, INDIA" pattern.
  if (!city) {
    const fallback = normalized.match(/,\s*([A-Za-z .'-]+?)\s+PIN\s+\d{6}\b/i);
    if (fallback) city = fallback[1].trim();
  }

  return {
    pin_code: pinCode,
    city: city ? city.toUpperCase() : null,
    state: state ? normalizeStateName(state) : null
  };
}

export function validateRpoAddressMapping(rpoCode, parsedAddress) {
  if (!rpoCode || !parsedAddress) return false;
  const allowed = RPO_REGION_MAP[rpoCode];
  if (!allowed) return false;

  const city = String(parsedAddress.city || '').toUpperCase();
  const state = normalizeStateName(String(parsedAddress.state || '').toUpperCase());

  return allowed.some((region) => city.includes(region) || state.includes(region));
}

export function inferRpoCodeFromAddress(parsedAddress) {
  if (!parsedAddress) return null;
  const city = String(parsedAddress.city || '').toUpperCase();
  const state = String(parsedAddress.state || '').toUpperCase();
  if (!city && !state) return null;

  for (const [code, regions] of Object.entries(RPO_REGION_MAP)) {
    if (regions.some((region) => city.includes(region) || state.includes(region))) {
      return code;
    }
  }
  return null;
}

export function inferRpoCodeFromCity(cityName = '') {
  const normalized = String(cityName).toUpperCase().trim();
  if (!normalized) return null;

  for (const [code, regions] of Object.entries(RPO_REGION_MAP)) {
    if (regions.some((region) => normalized.includes(region) || region.includes(normalized))) {
      return code;
    }
  }
  return null;
}

export function extractYearFromFileNumber(fileNumber = '') {
  const normalized = String(fileNumber).toUpperCase().trim();
  if (!normalized) return null;

  const match = normalized.match(/^[A-Z]+(\d{2})/);
  if (match) {
    const yy = Number(match[1]);
    return yy >= 50 ? 1900 + yy : 2000 + yy;
  }
  return null;
}
