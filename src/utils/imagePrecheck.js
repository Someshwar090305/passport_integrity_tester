/**
 * Lightweight pre-queue image precheck.
 *
 * Runs synchronously against the in-memory Multer buffer immediately after
 * upload validation and before writing to disk or enqueuing. No external
 * dependencies — only Buffer byte-parsing for JPEG/PNG dimension extraction.
 *
 * Checks (in order):
 *   1. Minimum file size  — tiny files are too compressed for reliable OCR
 *   2. Minimum resolution — low-res images produce unreadable MRZ zones
 *
 * If the format sub-variant is unrecognised and dimensions cannot be parsed,
 * the check is skipped (treated as pass). Google Vision will surface any true
 * format errors downstream.
 */

export const MIN_FILE_SIZE_BYTES = 50 * 1024; // 50 KB
export const MIN_WIDTH_PX  = 600;
export const MIN_HEIGHT_PX = 400;

/**
 * Parses width/height from a JPEG buffer by scanning for an SOF marker.
 * Handles SOF0 (baseline), SOF1 (extended sequential), SOF2 (progressive).
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function parseJpegDimensions(buf) {
  if (!buf || buf.length < 4) return null;
  // Must start with SOI marker: FF D8
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;

  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xFF) break;

    const marker = buf[offset + 1];

    // Skip fill bytes (multiple 0xFF before a real marker byte)
    if (marker === 0xFF) { offset += 1; continue; }

    // SOI and EOI have no length field — skip them
    if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }

    // All other segments have a 2-byte big-endian length (including the length bytes)
    if (offset + 4 > buf.length) break;
    const segmentLength = buf.readUInt16BE(offset + 2);

    // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2) — contain height at +5, width at +7
    if (marker >= 0xC0 && marker <= 0xC2 && segmentLength >= 9) {
      if (offset + 9 > buf.length) break;
      const height = buf.readUInt16BE(offset + 5);
      const width  = buf.readUInt16BE(offset + 7);
      return { width, height };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

/**
 * Parses width/height from a PNG buffer.
 * The IHDR chunk is always at a fixed offset in a valid PNG.
 *
 * Layout: 8-byte PNG signature | 4-byte IHDR length | 4-byte "IHDR" | 4-byte width | 4-byte height
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function parsePngDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) return null;

  const width  = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

/**
 * Auto-detects JPEG or PNG from magic bytes and returns { width, height }.
 * Returns null when the format is unrecognised or the buffer is too short.
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number } | null}
 */
export function parseDimensions(buf) {
  if (!buf || buf.length < 12) return null;

  // JPEG: FF D8 ...
  if (buf[0] === 0xFF && buf[1] === 0xD8) return parseJpegDimensions(buf);

  // PNG: 89 50 (0x89 'P' ...)
  if (buf[0] === 0x89 && buf[1] === 0x50) return parsePngDimensions(buf);

  return null;
}

/**
 * Checks a single image buffer for minimum size and resolution requirements.
 *
 * @param {Buffer} buffer
 * @param {'front_image'|'back_image'} fieldName
 * @returns {{
 *   pass: boolean,
 *   issues: Array<{ field: string, code: string, message: string, details: object }>,
 *   dimensions: { width: number, height: number } | null
 * }}
 */
export function precheckImage(buffer, fieldName) {
  const issues = [];
  const sizeKb = Math.round(buffer.length / 1024);

  // ── Check 1: minimum file size ───────────────────────────────────────────────
  if (buffer.length < MIN_FILE_SIZE_BYTES) {
    issues.push({
      field: fieldName,
      code: 'FILE_TOO_SMALL',
      message: `${fieldName} is ${sizeKb} KB, below the ${MIN_FILE_SIZE_BYTES / 1024} KB minimum. The image may be too compressed for reliable text extraction. Please upload a higher-quality photo.`,
      details: {
        size_kb: sizeKb,
        min_size_kb: MIN_FILE_SIZE_BYTES / 1024
      }
    });
    // File is too small — dimension parsing would be unreliable; stop here.
    return { pass: false, issues, dimensions: null };
  }

  // ── Check 2: minimum resolution ──────────────────────────────────────────────
  const dims = parseDimensions(buffer);

  if (dims !== null) {
    const { width, height } = dims;
    if (width < MIN_WIDTH_PX || height < MIN_HEIGHT_PX) {
      issues.push({
        field: fieldName,
        code: 'RESOLUTION_TOO_LOW',
        message: `${fieldName} resolution is ${width}×${height}px, below the minimum ${MIN_WIDTH_PX}×${MIN_HEIGHT_PX}px. Please retake the photo closer to the passport, ensuring the full page is clearly in frame.`,
        details: {
          width_px: width,
          height_px: height,
          min_width_px: MIN_WIDTH_PX,
          min_height_px: MIN_HEIGHT_PX
        }
      });
    }
  }
  // dims === null means format sub-variant not parseable → treat as pass,
  // Vision API will surface any real format errors.

  return {
    pass: issues.length === 0,
    issues,
    dimensions: dims
  };
}

/**
 * Runs the precheck on both passport images and returns a combined result.
 *
 * @param {Buffer} frontBuffer
 * @param {Buffer} backBuffer
 * @returns {{
 *   pass: boolean,
 *   front: object,
 *   back: object,
 *   issues: Array,
 *   user_message: string | null
 * }}
 */
export function precheckPassportImages(frontBuffer, backBuffer) {
  const front = precheckImage(frontBuffer, 'front_image');
  const back  = precheckImage(backBuffer,  'back_image');

  const allIssues = [...front.issues, ...back.issues];
  const pass = front.pass && back.pass;

  let user_message = null;
  if (!pass) {
    const failingPages = [];
    if (!front.pass) failingPages.push('front');
    if (!back.pass)  failingPages.push('back');

    const pageLabel =
      failingPages.length === 2 ? 'Both passport images' : `The ${failingPages[0]} image`;

    const detail = allIssues.map((i) => i.message).join(' ');
    user_message = `${pageLabel} could not be accepted. ${detail}`;
  }

  return { pass, front, back, issues: allIssues, user_message };
}
