import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseDimensions,
  parseJpegDimensions,
  parsePngDimensions,
  precheckImage,
  precheckPassportImages,
  MIN_FILE_SIZE_BYTES,
  MIN_WIDTH_PX,
  MIN_HEIGHT_PX
} from '../src/utils/imagePrecheck.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a minimal valid JPEG buffer with the given dimensions.
 * Contains only: SOI marker + APP0 (JFIF) + SOF0 (with dimensions) + EOI.
 */
function buildJpeg(width, height, padToBytes = 0) {
  // SOI
  const soi = Buffer.from([0xFF, 0xD8]);

  // APP0 segment: FF E0, length=16, "JFIF\0", version, units, Xdensity, Ydensity, Xthumbnail, Ythumbnail
  const app0 = Buffer.from([
    0xFF, 0xE0,
    0x00, 0x10, // length = 16
    0x4A, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version
    0x00,       // units
    0x00, 0x01, // Xdensity
    0x00, 0x01, // Ydensity
    0x00, 0x00  // thumbnails
  ]);

  // SOF0 segment: FF C0, length=11, precision=8, height(2), width(2), components=1, component
  const sof0 = Buffer.alloc(13);
  sof0[0] = 0xFF; sof0[1] = 0xC0;
  sof0.writeUInt16BE(11, 2); // segment length
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1; // num components
  sof0[10] = 1; sof0[11] = 0x11; sof0[12] = 0; // component spec

  // EOI
  const eoi = Buffer.from([0xFF, 0xD9]);

  const core = Buffer.concat([soi, app0, sof0, eoi]);

  // Pad to simulate a real file size if needed
  if (padToBytes > core.length) {
    const padding = Buffer.alloc(padToBytes - core.length);
    return Buffer.concat([core, padding]);
  }
  return core;
}

/**
 * Builds a minimal valid PNG buffer with the given dimensions.
 */
function buildPng(width, height, padToBytes = 0) {
  const buf = Buffer.alloc(Math.max(24, padToBytes));
  // PNG signature
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4E; buf[3] = 0x47;
  buf[4] = 0x0D; buf[5] = 0x0A; buf[6] = 0x1A; buf[7] = 0x0A;
  // IHDR chunk length
  buf.writeUInt32BE(13, 8);
  // IHDR type
  buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52;
  // width and height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * Returns a buffer large enough to pass the file-size check but with
 * an unrecognised image format (not JPEG or PNG).
 */
function buildUnknownFormat(size = MIN_FILE_SIZE_BYTES + 1) {
  const buf = Buffer.alloc(size, 0xAB);
  return buf;
}

// ── parseDimensions ───────────────────────────────────────────────────────────

test('parseDimensions extracts correct dimensions from a synthetic JPEG', () => {
  const buf = buildJpeg(1200, 900, MIN_FILE_SIZE_BYTES + 1);
  const dims = parseDimensions(buf);
  assert.deepStrictEqual(dims, { width: 1200, height: 900 });
});

test('parseDimensions extracts correct dimensions from a synthetic PNG', () => {
  const buf = buildPng(1280, 960, MIN_FILE_SIZE_BYTES + 1);
  const dims = parseDimensions(buf);
  assert.deepStrictEqual(dims, { width: 1280, height: 960 });
});

test('parseDimensions returns null for unknown format', () => {
  assert.equal(parseDimensions(buildUnknownFormat()), null);
});

test('parseDimensions returns null for empty / short buffer', () => {
  assert.equal(parseDimensions(null), null);
  assert.equal(parseDimensions(Buffer.alloc(0)), null);
  assert.equal(parseDimensions(Buffer.alloc(4)), null);
});

// ── precheckImage ─────────────────────────────────────────────────────────────

test('precheckImage: passes a good JPEG (large file, high resolution)', () => {
  const buf = buildJpeg(1200, 900, MIN_FILE_SIZE_BYTES + 1024);
  const result = precheckImage(buf, 'front_image');
  assert.equal(result.pass, true);
  assert.equal(result.issues.length, 0);
  assert.deepStrictEqual(result.dimensions, { width: 1200, height: 900 });
});

test('precheckImage: rejects when file size is below minimum', () => {
  // Build a JPEG smaller than MIN_FILE_SIZE_BYTES
  const buf = buildJpeg(1200, 900, 10 * 1024); // only 10 KB
  const result = precheckImage(buf, 'front_image');
  assert.equal(result.pass, false);
  assert.equal(result.issues[0].code, 'FILE_TOO_SMALL');
  assert.equal(result.issues[0].field, 'front_image');
  assert.equal(result.dimensions, null, 'dimensions not parsed when file too small');
});

test('precheckImage: rejects when resolution is below minimum (width too low)', () => {
  const buf = buildJpeg(400, 900, MIN_FILE_SIZE_BYTES + 1024); // width 400 < 600
  const result = precheckImage(buf, 'back_image');
  assert.equal(result.pass, false);
  assert.equal(result.issues[0].code, 'RESOLUTION_TOO_LOW');
  assert.equal(result.issues[0].details.width_px, 400);
});

test('precheckImage: rejects when resolution is below minimum (height too low)', () => {
  const buf = buildJpeg(1200, 200, MIN_FILE_SIZE_BYTES + 1024); // height 200 < 400
  const result = precheckImage(buf, 'front_image');
  assert.equal(result.pass, false);
  assert.equal(result.issues[0].code, 'RESOLUTION_TOO_LOW');
  assert.equal(result.issues[0].details.height_px, 200);
});

test('precheckImage: passes an unknown-format buffer that is large enough (dimensions not parseable)', () => {
  // A non-JPEG/PNG buffer of sufficient size — treated as pass (Vision handles it)
  const buf = buildUnknownFormat(MIN_FILE_SIZE_BYTES + 1);
  const result = precheckImage(buf, 'front_image');
  assert.equal(result.pass, true);
  assert.equal(result.dimensions, null);
});

test('precheckImage: passes a PNG at exactly the minimum resolution', () => {
  const buf = buildPng(MIN_WIDTH_PX, MIN_HEIGHT_PX, MIN_FILE_SIZE_BYTES + 1024);
  const result = precheckImage(buf, 'front_image');
  assert.equal(result.pass, true);
});

test('precheckImage: rejects a PNG that is 1px below minimum width', () => {
  const buf = buildPng(MIN_WIDTH_PX - 1, MIN_HEIGHT_PX, MIN_FILE_SIZE_BYTES + 1024);
  const result = precheckImage(buf, 'back_image');
  assert.equal(result.pass, false);
  assert.equal(result.issues[0].code, 'RESOLUTION_TOO_LOW');
});

// ── precheckPassportImages ────────────────────────────────────────────────────

test('precheckPassportImages: passes when both images are valid', () => {
  const front = buildJpeg(1200, 900, MIN_FILE_SIZE_BYTES + 1);
  const back  = buildJpeg(1100, 850, MIN_FILE_SIZE_BYTES + 1);
  const result = precheckPassportImages(front, back);
  assert.equal(result.pass, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.user_message, null);
});

test('precheckPassportImages: fails when front is too small', () => {
  const front = buildJpeg(1200, 900, 10 * 1024); // too small
  const back  = buildJpeg(1100, 850, MIN_FILE_SIZE_BYTES + 1);
  const result = precheckPassportImages(front, back);
  assert.equal(result.pass, false);
  assert.ok(result.user_message.includes('front'), 'message mentions front page');
  assert.ok(result.issues.some((i) => i.code === 'FILE_TOO_SMALL'));
});

test('precheckPassportImages: fails when back has low resolution', () => {
  const front = buildJpeg(1200, 900, MIN_FILE_SIZE_BYTES + 1);
  const back  = buildJpeg(300, 200, MIN_FILE_SIZE_BYTES + 1); // too low-res
  const result = precheckPassportImages(front, back);
  assert.equal(result.pass, false);
  assert.ok(result.issues.some((i) => i.code === 'RESOLUTION_TOO_LOW' && i.field === 'back_image'));
});

test('precheckPassportImages: fails both and includes "Both passport images" in message', () => {
  const front = buildJpeg(300, 200, MIN_FILE_SIZE_BYTES + 1); // low-res
  const back  = buildJpeg(300, 200, MIN_FILE_SIZE_BYTES + 1); // low-res
  const result = precheckPassportImages(front, back);
  assert.equal(result.pass, false);
  assert.ok(result.user_message.startsWith('Both passport images'));
  assert.equal(result.issues.length, 2);
});
