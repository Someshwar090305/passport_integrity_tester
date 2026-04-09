import axios from 'axios';
import JSZip from 'jszip';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function looksLikeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepCollectByKeys(root, keys) {
  const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
  const found = [];
  const stack = [root];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(String(key).toLowerCase()) && value !== undefined && value !== null && value !== '') {
        found.push(value);
      }
      if (typeof value === 'object' && value !== null) {
        stack.push(value);
      }
    }
  }

  return found;
}

function firstString(values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '') || null;
}

function deepCollectStrings(root) {
  const found = [];
  const stack = [root];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string') {
      found.push(current);
      continue;
    }
    if (typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const value of Object.values(current)) {
      stack.push(value);
    }
  }

  return found;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHtmlPassportFields(raw) {
  const blobs = deepCollectStrings(raw).filter((value) => {
    const lowered = value.toLowerCase();
    return lowered.includes('<html') || lowered.includes('passport') || lowered.includes('mrz');
  });
  if (blobs.length === 0) return {};

  const text = stripHtml(blobs.join(' '));

  const mrzMatch =
    text.match(/[A-Z0-9<]{40,}<<[A-Z0-9<]{5,}/) ||
    text.match(/[A-Z0-9<]{44}/);
  const mrzLine2Match = text.match(/[A-Z0-9][A-Z0-9<]{8}[0-9<]IND[0-9<]{6}[MF<][0-9<]{7,}/);
  const passportNumberMatch =
    text.match(/\bPassport\s*No\.?\s*([A-Z0-9]{7,9})\b/i) ||
    text.match(/\b([A-Z][0-9]{7})\b/);
  const dobMatch =
    text.match(/\bDate\s*of\s*Birth\s*([0-3]?\d\/[01]?\d\/\d{4})\b/i) ||
    text.match(/\bDOB\s*[:\-]?\s*([0-3]?\d\/[01]?\d\/\d{4})\b/i) ||
    text.match(/\bDate\s*of\s*Birth[\s\S]{0,40}?([0-3]?\d\/[01]?\d\/\d{4})\b/i) ||
    text.match(/\bजन्मतिथि[\s\S]{0,40}?([0-3]?\d\/[01]?\d\/\d{4})\b/i);
  const expiryMatch = text.match(/\bDate\s*of\s*Expiry\s*([0-3]?\d\/[01]?\d\/\d{4})\b/i);
  const fileNoMatch =
    text.match(/\bFile\s*No\.?\s*[:\-]?\s*([A-Z]{2,4}[0-9]{8,})\b/i) ||
    text.match(/\bFile\s*No\.?\s*[\/|]?\s*File\s*No\.?\s*[:\-]?\s*([A-Z]{2,4}[0-9]{8,})\b/i) ||
    text.match(/\b([A-Z]{2,4}[0-9]{10,})\b/);
  const pinMatch = text.match(/\b(?:PIN|Pin)\s*[:\-]?\s*(\d{6})\b/);

  // Capture a reasonably sized address segment around known anchor words.
  const addressAnchor =
    text.match(/\bAddress\b[\s\S]{0,220}\b(?:INDIA|\d{6})\b/i) ||
    text.match(/\bANNA\s+NAGAR[\s\S]{0,160}\b(?:INDIA|\d{6})\b/i);

  const derivedMrzLine2 = mrzLine2Match?.[0] || null;
  const derivedMrz = mrzMatch?.[0] || null;
  const mrzLine2 = [derivedMrzLine2, derivedMrz].find(
    (line) => typeof line === 'string' && line.length >= 28
  ) || null;

  return {
    mrz_line2: mrzLine2,
    passport_number: passportNumberMatch?.[1] || null,
    date_of_birth: dobMatch?.[1] || null,
    expiry_date: expiryMatch?.[1] || null,
    file_number: fileNoMatch?.[1] || null,
    address_block: addressAnchor?.[0] || (pinMatch ? `PIN:${pinMatch[1]}` : null)
  };
}

function extractVisualDobFromMetadata(raw) {
  const metadataTexts = deepCollectStrings(raw).filter((text) => {
    const lowered = String(text).toLowerCase();
    return lowered.includes('date of birth') || lowered.includes('dob') || lowered.includes('जन्मतिथि');
  });

  for (const text of metadataTexts) {
    const match =
      String(text).match(/\bDate\s*of\s*Birth[\s\S]{0,40}?([0-3]?\d\/[01]?\d\/\d{4})\b/i) ||
      String(text).match(/\bDOB[\s\S]{0,20}?([0-3]?\d\/[01]?\d\/\d{4})\b/i) ||
      String(text).match(/\bजन्मतिथि[\s\S]{0,40}?([0-3]?\d\/[01]?\d\/\d{4})\b/i) ||
      String(text).match(/\b([0-3]?\d\/[01]?\d\/\d{4})\s*[MF]\b/);
    if (match) return match[1];
  }

  return null;
}

function mergeAddressCandidates(root) {
  const fullAddress = firstString(
    deepCollectByKeys(root, [
      'address',
      'address_block',
      'full_address',
      'current_address',
      'residential_address'
    ])
  );

  if (fullAddress) return fullAddress;

  const line1 = firstString(deepCollectByKeys(root, ['address_line_1', 'address1', 'line1'])) || '';
  const line2 = firstString(deepCollectByKeys(root, ['address_line_2', 'address2', 'line2'])) || '';
  const city = firstString(deepCollectByKeys(root, ['city', 'town'])) || '';
  const state = firstString(deepCollectByKeys(root, ['state', 'province'])) || '';
  const pin = firstString(deepCollectByKeys(root, ['pin_code', 'pincode', 'postal_code', 'zip'])) || '';

  const merged = [line1, line2, city, state, pin].filter(Boolean).join(', ').trim();
  return merged || null;
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
  return value;
}

export function normalizeSarvamResponse(raw = {}) {
  const front = raw.front || raw.data?.front || raw.result?.front || {};
  const back = raw.back || raw.data?.back || raw.result?.back || {};
  const htmlFields = extractHtmlPassportFields(raw);
  const visualDobFromMetadata = extractVisualDobFromMetadata(raw);

  const mrzLine2FromDeep = firstString(
    deepCollectByKeys(raw, ['mrz_line_2', 'mrzline2', 'mrz_line2', 'mrz_2', 'line2'])
  );
  const mrzLine2 = pick(
    raw.mrz?.line2,
    raw.mrz_line2,
    front.mrz_line2,
    front.mrz?.line2,
    raw.data?.mrz?.line2,    
    htmlFields.mrz_line2,
    mrzLine2FromDeep
  );

  const passportNumber = firstString(
    [
      htmlFields.passport_number,
      ...deepCollectByKeys(raw, ['passport_number', 'passport_no', 'document_number', 'passportnumber'])
    ]
  );
  const dateOfBirth = normalizeDateString(
    pick(
      front.date_of_birth,
      raw.date_of_birth,
      raw.visual?.date_of_birth,
      htmlFields.date_of_birth,
      visualDobFromMetadata,
      firstString(deepCollectByKeys(raw, ['date_of_birth', 'dob', 'birth_date']))
    )
  );
  const expiryDate = normalizeDateString(
    pick(
      htmlFields.expiry_date,
      firstString(deepCollectByKeys(raw, ['expiry_date', 'date_of_expiry', 'expiry', 'valid_till']))
    )
  );
  const fileNumber = pick(
    htmlFields.file_number,
    firstString(deepCollectByKeys(raw, ['file_number', 'filenumber', 'application_number']))
  );
  const addressBlock = pick(
    back.address_block,
    raw.address,
    raw.address_block,
    htmlFields.address_block,
    mergeAddressCandidates(raw)
  );

  return {
    front: {
      mrz_line2: mrzLine2 || null,
      date_of_birth: dateOfBirth || null,
      passport_number: passportNumber || null,
      expiry_date: expiryDate || null
    },
    back: {
      file_number: pick(back.file_number, raw.file_number, fileNumber) || null,
      address_block: addressBlock || null
    },
    passport_number: passportNumber || null,
    date_of_birth: dateOfBirth || null,
    expiry_date: expiryDate || null,
    file_number: fileNumber || null,
    address: addressBlock || null,
    raw
  };
}

function buildSarvamError(error) {
  const responseBody = error.response?.data;
  const message = responseBody?.error?.message || responseBody?.message || error.message;
  const code = responseBody?.error?.code || error.code || 'unknown_error';
  const requestId = responseBody?.error?.request_id || 'unknown_request_id';
  // eslint-disable-next-line no-console
  console.error('[sarvam] full error response:', JSON.stringify(responseBody ?? error.message, null, 2));
  return new Error(`Sarvam request failed: ${message} (code=${code}, request_id=${requestId})`);
}

function extensionFromMimeType(mimeType = '') {
  const normalized = String(mimeType).toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg') return '.jpg';
  return '.bin';
}

function sanitizeFilename(fileName) {
  return String(fileName || '').replace(/[^\w.-]+/g, '_');
}

function decodeImageBuffer(imageEncoded) {
  return Buffer.from(imageEncoded.dataBase64, 'base64');
}

async function buildZipForSarvam(frontImageEncoded, backImageEncoded) {
  const zip = new JSZip();
  const frontName =
    sanitizeFilename(frontImageEncoded.originalname) ||
    `front${extensionFromMimeType(frontImageEncoded.mimetype)}`;
  const backName =
    sanitizeFilename(backImageEncoded.originalname) ||
    `back${extensionFromMimeType(backImageEncoded.mimetype)}`;

  zip.file(frontName, decodeImageBuffer(frontImageEncoded));
  zip.file(backName, decodeImageBuffer(backImageEncoded));

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const zipFileName = `passport_bundle_${Date.now()}.zip`;

  return { zipFileName, zipBuffer };
}

function parseJobParameters() {
  const raw = process.env.SARVAM_JOB_PARAMETERS_JSON;
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('SARVAM_JOB_PARAMETERS_JSON must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid SARVAM_JOB_PARAMETERS_JSON: ${error.message}`);
  }
}

function buildResultUrl(template, jobId) {
  return template.replace('{job_id}', encodeURIComponent(String(jobId)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveDownloadArtifact(jobId, payload) {
  const shouldSave = String(process.env.SARVAM_SAVE_DOWNLOADS || '').toLowerCase() === 'true';
  if (!shouldSave) return;

  const baseDir = process.env.SARVAM_DOWNLOAD_DIR || './artifacts/sarvam';
  const dir = path.resolve(baseDir, String(jobId));
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'download-response.json');
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[sarvam] saved download artifact: ${filePath}`);
}

async function fetchAndExtractZipContents(downloadData) {
  const downloadUrl = pick(
    downloadData?.download_urls?.['document.zip']?.file_url,
    ...Object.values(downloadData?.download_urls || {}).map((entry) => entry?.file_url)
  );
  if (!downloadUrl) return null;

  const response = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 30000
  });
  const zipBuffer = Buffer.from(response.data);
  const zip = await JSZip.loadAsync(zipBuffer);

  const extractedFiles = [];
  const tasks = [];
  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    const lower = relativePath.toLowerCase();
    const isTextLike =
      lower.endsWith('.html') ||
      lower.endsWith('.htm') ||
      lower.endsWith('.txt') ||
      lower.endsWith('.json') ||
      lower.endsWith('.xml') ||
      lower.endsWith('.csv') ||
      lower.endsWith('.md');
    if (!isTextLike) return;

    tasks.push(
      zipEntry.async('string').then((content) => {
        extractedFiles.push({ path: relativePath, content });
      })
    );
  });
  await Promise.all(tasks);
  return extractedFiles;
}

function extractStatus(payload) {
  return pick(
    payload?.job_state,
    payload?.status,
    payload?.data?.status,
    payload?.result?.status
  );
}

function isTerminalSuccessStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'completed' || normalized === 'succeeded' || normalized === 'done';
}

function isTerminalFailureStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return normalized === 'failed' || normalized === 'error';
}

async function pollJobStatus({
  statusUrlTemplate,
  apiKey,
  jobId,
  maxAttempts,
  pollIntervalMs
}) {
  let lastPayload = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const url = buildResultUrl(statusUrlTemplate, jobId);
    const { data } = await axios.get(url, {
      headers: {
        'api-subscription-key': apiKey,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
    lastPayload = data;
    const status = extractStatus(data);
    // eslint-disable-next-line no-console
    console.log(`[sarvam] poll attempt ${attempt}/${maxAttempts} — status: ${status}`);
    if (isTerminalSuccessStatus(status)) {
      return data;
    }
    if (isTerminalFailureStatus(status)) {
      throw new Error(`Sarvam job failed with status=${status}`);
    }

    if (attempt < maxAttempts) {
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(`Sarvam job did not complete in ${maxAttempts} polling attempts`);
}

async function runSingleFileJob({
  uploadUrl,
  startUrlTemplate,
  statusUrlTemplate,
  downloadUrlTemplate,
  createJobUrl,
  apiKey,
  fileName,
  fileBuffer
}) {
  const { data: createJobData } = await axios.post(createJobUrl, {
    job_parameters: parseJobParameters()
  }, {
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  const sarvamJobId = pick(
    createJobData?.job_id,
    createJobData?.data?.job_id,
    createJobData?.result?.job_id
  );
  if (!sarvamJobId) {
    throw new Error('Sarvam create job response missing job_id');
  }

  const { data: uploadData } = await axios.post(uploadUrl, {
    job_id: String(sarvamJobId),
    files: [fileName]
  }, {
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  const uploadDescriptor = uploadData?.upload_urls?.[fileName];
  const uploadFileUrl = uploadDescriptor?.file_url;
  if (!uploadFileUrl) {
    throw new Error(`Sarvam upload URL missing for file: ${fileName}`);
  }

  // Use octet-stream as the safe default for binary uploads.
  // Sarvam may override this via file_metadata in the upload descriptor (applied below).
  // x-ms-blob-type is mandatory for Azure Blob Storage SAS uploads.
  const uploadHeaders = {
    'Content-Type': 'application/octet-stream',
    'x-ms-blob-type': 'BlockBlob'
  };
  const fileMetadata = uploadDescriptor?.file_metadata;
  if (fileMetadata && typeof fileMetadata === 'object' && !Array.isArray(fileMetadata)) {
    for (const [key, value] of Object.entries(fileMetadata)) {
      if (value !== undefined && value !== null && typeof value !== 'object') {
        uploadHeaders[key] = String(value);
      }
    }
  }

  await axios.put(uploadFileUrl, fileBuffer, {
    headers: uploadHeaders,
    timeout: 30000
  });

  const startUrl = buildResultUrl(startUrlTemplate, sarvamJobId);
  await axios.post(startUrl, {}, {
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  const maxAttempts = Number(process.env.SARVAM_RESULT_POLL_ATTEMPTS || 12);
  const pollIntervalMs = Number(process.env.SARVAM_RESULT_POLL_INTERVAL_MS || 1500);
  await pollJobStatus({
    statusUrlTemplate,
    apiKey,
    jobId: sarvamJobId,
    maxAttempts,
    pollIntervalMs
  });

  const downloadUrl = buildResultUrl(downloadUrlTemplate, sarvamJobId);
  const { data: downloadData } = await axios.post(downloadUrl, {}, {
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  const extractedOutputFiles = await fetchAndExtractZipContents(downloadData);
  if (extractedOutputFiles && extractedOutputFiles.length > 0) {
    downloadData.extracted_output_files = extractedOutputFiles;
  }

  await saveDownloadArtifact(sarvamJobId, downloadData);

  return normalizeSarvamResponse(downloadData);
}

export async function extractPassportData(frontImageEncoded, backImageEncoded) {
  const uploadUrl = process.env.SARVAM_API_URL;
  const startUrlTemplate = process.env.SARVAM_START_JOB_URL_TEMPLATE;
  const statusUrlTemplate = process.env.SARVAM_STATUS_URL_TEMPLATE;
  const downloadUrlTemplate = process.env.SARVAM_DOWNLOAD_URL_TEMPLATE;
  const apiKey = process.env.SARVAM_API_KEY;
  const createJobUrl = process.env.SARVAM_CREATE_JOB_URL || 'https://api.sarvam.ai/doc-digitization/job/v1';

  if (!uploadUrl || !apiKey || !startUrlTemplate || !statusUrlTemplate || !downloadUrlTemplate) {
    throw new Error(
      'SARVAM_API_URL, SARVAM_API_KEY, SARVAM_START_JOB_URL_TEMPLATE, SARVAM_STATUS_URL_TEMPLATE, and SARVAM_DOWNLOAD_URL_TEMPLATE are required'
    );
  }

  try {
    const { zipFileName, zipBuffer } = await buildZipForSarvam(frontImageEncoded, backImageEncoded);
    const result = await runSingleFileJob({
      uploadUrl,
      startUrlTemplate,
      statusUrlTemplate,
      downloadUrlTemplate,
      createJobUrl,
      apiKey,
      fileName: zipFileName,
      fileBuffer: zipBuffer
    });

    return {
      front: result.front,
      back: result.back,
      raw: {
        bundled_job: result.raw
      }
    };
  } catch (error) {
    throw buildSarvamError(error);
  }
}
