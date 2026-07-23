import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVisionTextMetrics,
  assessPageQuality,
  assessOcrImageQuality
} from '../src/services/imageQuality.js';

function buildVisionAnnotation(confidences) {
  return {
    pages: [
      {
        blocks: [
          {
            paragraphs: [
              {
                words: confidences.map((confidence) => ({ confidence }))
              }
            ]
          }
        ]
      }
    ]
  };
}

function strongFrontOcr(overrides = {}) {
  return {
    passport_number: 'A1234567',
    date_of_birth: '1990-01-01',
    expiry_date: '2030-01-01',
    front: {
      mrz_line1: 'P<INDSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      mrz_line2: 'A12345670IND9001011M3001011<<<<<<<<<<<<<<<6',
      passport_number: 'A1234567',
      date_of_birth: '1990-01-01',
      expiry_date: '2030-01-01'
    },
    raw: {
      google_vision: {
        front: 'P<INDSMITH passport text Date of Birth 01/01/1990',
        back: 'File No. MAA1234567890 Address Chennai PIN 600040 Tamil Nadu',
        front_meta: { wordCount: 20, avgConfidence: 0.92, minConfidence: 0.8 },
        back_meta: { wordCount: 15, avgConfidence: 0.9, minConfidence: 0.75 }
      }
    },
    ...overrides
  };
}

test('extractVisionTextMetrics aggregates word confidence values', () => {
  const metrics = extractVisionTextMetrics(buildVisionAnnotation([0.9, 0.8, 0.7]));

  assert.equal(metrics.wordCount, 3);
  assert.ok(Math.abs(metrics.avgConfidence - 0.8) < 0.0001);
  assert.equal(metrics.minConfidence, 0.7);
});

test('extractVisionTextMetrics returns null confidence when annotation is empty', () => {
  const metrics = extractVisionTextMetrics(null);

  assert.equal(metrics.wordCount, 0);
  assert.equal(metrics.avgConfidence, null);
  assert.equal(metrics.minConfidence, null);
});

test('assessOcrImageQuality accepts strong front and back extraction', () => {
  const result = assessOcrImageQuality(strongFrontOcr({
    back: {
      file_number: 'MAA1234567890',
      address_block: '12 Main St, Chennai PIN 600040, Tamil Nadu'
    },
    file_number: 'MAA1234567890',
    address: '12 Main St, Chennai PIN 600040, Tamil Nadu'
  }));

  assert.equal(result.acceptable, true);
  assert.equal(result.user_message, null);
  assert.equal(result.front.acceptable, true);
  assert.equal(result.back.acceptable, true);
});

test('assessOcrImageQuality rejects front page when MRZ line2 is missing even if some front fields exist', () => {
  const result = assessOcrImageQuality({
    front: {
      mrz_line1: 'P<INDTACHAMBARA<SESHADRI<<ESHWARAN<<<<<<<<<<',
      passport_number: 'AR914664',
      date_of_birth: '1977-12-17',
      expiry_date: '2036-05-25'
    },
    back: {
      file_number: 'MAA1234567890',
      address_block: '12 Main St, Chennai PIN 600040, Tamil Nadu'
    },
    raw: {
      google_vision: {
        front: 'P<INDTACHAMBARA<SESHADRI<<ESHWARAN<<<<<<<<<< Passport No. AR914664 Date of Birth 17/12/1977 Date of Expiry 25/05/2036',
        back: 'File No. MAA1234567890 Address Chennai PIN 600040 Tamil Nadu India',
        front_meta: { wordCount: 50, avgConfidence: 0.86, minConfidence: 0.35 },
        back_meta: { wordCount: 15, avgConfidence: 0.9, minConfidence: 0.75 }
      }
    }
  });

  assert.equal(result.acceptable, false);
  assert.equal(result.front.acceptable, false);
  assert.ok(result.front.issues.includes('FRONT_MRZ_UNREADABLE'));
  assert.match(result.user_message, /Front image needs to be retaken/i);
});

test('assessOcrImageQuality rejects back page with no readable anchors', () => {
  const result = assessOcrImageQuality(strongFrontOcr({
    back: {},
    file_number: null,
    address: null,
    raw: {
      google_vision: {
        front: strongFrontOcr().raw.google_vision.front,
        back: 'noise',
        front_meta: { wordCount: 20, avgConfidence: 0.92, minConfidence: 0.8 },
        back_meta: { wordCount: 1, avgConfidence: 0.4, minConfidence: 0.4 }
      }
    }
  }));

  assert.equal(result.acceptable, false);
  assert.equal(result.back.acceptable, false);
  assert.ok(result.back.issues.includes('BACK_TEXT_UNREADABLE'));
  assert.ok(result.back.issues.includes('BACK_ANCHORS_MISSING'));
});

test('assessPageQuality allows strong front extraction despite short raw text', () => {
  const result = assessPageQuality({
    text: 'short',
    normalized: strongFrontOcr(),
    metrics: { wordCount: 12, avgConfidence: 0.9, minConfidence: 0.82 },
    page: 'front'
  });

  assert.equal(result.acceptable, true);
  assert.equal(result.metrics.extraction_strong, true);
});

test('assessPageQuality rejects strong extraction when confidence is extremely low', () => {
  const result = assessPageQuality({
    text: 'long enough passport text with labels and values',
    normalized: strongFrontOcr(),
    metrics: { wordCount: 12, avgConfidence: 0.5, minConfidence: 0.4 },
    page: 'front'
  });

  assert.equal(result.acceptable, false);
  assert.ok(result.issues.includes('OCR_CONFIDENCE_LOW'));
});

test('assessOcrImageQuality rejects both pages when front and back fail', () => {
  const result = assessOcrImageQuality({
    front: {},
    back: {},
    raw: {
      google_vision: {
        front: '',
        back: '',
        front_meta: { wordCount: 0, avgConfidence: null, minConfidence: null },
        back_meta: { wordCount: 0, avgConfidence: null, minConfidence: null }
      }
    }
  });

  assert.equal(result.acceptable, false);
  assert.match(result.user_message, /Both passport images need to be retaken/i);
  assert.ok(result.issue_details.length >= 2);
});
