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
  GUW: ['GUWAHATI', 'ASSAM', 'NORTH EAST'],
  PAT: ['PATNA', 'BIHAR'],
  RAN: ['RANCHI', 'JHARKHAND'],
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
  MAA: ['CHENNAI', 'TAMIL NADU'],
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
  RNC: ['RANCHI'],
  GOI: ['GOA', 'PANAJI']
};

const RPO_PREFIX_ALIAS_MAP = {
  MA: 'MAA', // Observed in sample file numbers like MA207...
  BO: 'BOM',
  DE: 'DEL',
  BL: 'BLR',
  HY: 'HYD',
  KO: 'KOL'
};

export function extractRpoCode(fileNumber = '') {
  const normalized = String(fileNumber).toUpperCase().trim();
  const match = normalized.match(/^[A-Z]{3}/);
  if (match) return match[0];

  const twoLetter = normalized.match(/^[A-Z]{2}(?=\d)/);
  if (!twoLetter) return null;
  return RPO_PREFIX_ALIAS_MAP[twoLetter[0]] || null;
}

export function parseAddressBlock(addressText = '') {
  const raw = String(addressText || '');
  const compact = raw.replace(/\s+/g, ' ').trim();
  const pinMatch = compact.match(/\b(?:PIN\s*[:\-]?\s*)?(\d{6})\b/i);
  const pinCode = pinMatch ? pinMatch[1] : null;

  // Normalize key separators around PIN and commas to improve regex extraction.
  const normalized = compact
    .replace(/\bPIN\s*[:\-]?\s*(\d{6})\b/gi, ' PIN $1 ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strong pattern for OCR strings like:
  // "... ANNA NAGAR, CHENNAI PIN 600040, TAMIL NADU, INDIA"
  const pinAnchored = normalized.match(
    /,\s*([A-Za-z .'-]+?)\s+PIN\s+\d{6}\s*,\s*([A-Za-z .'-]+?)\s*(?:,|$)/i
  );
  if (pinAnchored) {
    return {
      pin_code: pinCode,
      city: pinAnchored[1].trim().toUpperCase(),
      state: pinAnchored[2].trim().toUpperCase()
    };
  }

  const cityStatePatterns = [
    /,\s*([A-Za-z .'-]+)\s*,\s*([A-Za-z .'-]+)\s*(?:PIN\s*)?\d{6}\b/i,
    /\b([A-Za-z .'-]+)\s*,\s*([A-Za-z .'-]+)\s*(?:PIN\s*)?\d{6}\b/i,
    /,\s*([A-Za-z .'-]+)\s*(?:PIN\s*)?\d{6}\b/i
  ];

  let city = null;
  let state = null;
  for (const pattern of cityStatePatterns) {
    const match = normalized.match(pattern);
    if (match) {
      city = match[1].trim();
      state = match[2] ? match[2].trim() : null;
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
    state: state ? state.toUpperCase() : null
  };
}

export function validateRpoAddressMapping(rpoCode, parsedAddress) {
  if (!rpoCode || !parsedAddress) return false;
  const allowed = RPO_REGION_MAP[rpoCode];
  if (!allowed) return false;

  const city = String(parsedAddress.city || '').toUpperCase();
  const state = String(parsedAddress.state || '').toUpperCase();

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
