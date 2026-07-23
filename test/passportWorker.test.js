import test from 'node:test';
import assert from 'node:assert/strict';
import { processPassportJob, cleanupTempFiles } from '../src/worker/jobProcessor.js';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const JOB_DATA = {
  jobId: 'job_TEST01',
  front: { path: '/tmp/test_front.jpg', mimetype: 'image/jpeg', originalname: 'front.jpg' },
  back:  { path: '/tmp/test_back.jpg',  mimetype: 'image/jpeg', originalname: 'back.jpg'  }
};

/** Returns a minimal job object that looks like a BullMQ Job. */
function makeJob(overrides = {}) {
  return {
    data:        JOB_DATA,
    timestamp:   Date.now() - 500,
    processedOn: Date.now(),
    attemptsMade: 0,
    opts: { attempts: 3 },
    ...overrides
  };
}

const MOCK_OCR_RESULT = {
  passport_number: 'A1234567',
  date_of_birth:   '1990-01-01',
  expiry_date:     '2030-01-01',
  file_number:     'MAA1234567890',
  address:         '12 Main St, Chennai PIN 600040, Tamil Nadu, India',
  front: {
    mrz_line1: 'P<INDSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    mrz_line2: 'A12345670IND9001011M3001011<<<<<<<<<<<<<<<6',
    passport_number: 'A1234567',
    date_of_birth:   '1990-01-01',
    expiry_date:     '2030-01-01'
  },
  back: {
    file_number:   'MAA1234567890',
    address_block: '12 Main St, Chennai PIN 600040, Tamil Nadu, India'
  },
  raw: { google_vision: { front: 'front ocr text', back: 'back ocr text' } }
};

const MOCK_QUALITY_OK = {
  acceptable: true,
  front: { acceptable: true, issues: [], metrics: {} },
  back: { acceptable: true, issues: [], metrics: {} },
  user_message: null,
  issue_details: []
};

const MOCK_VALIDATION = {
  verificationStatus: 'PASSED',
  integrityScore:     95,
  integrityTier:      'HIGH',
  reviewRequired:     false,
  failedChecks:       [],
  integrityFlags: {
    mrz_checksums_valid:        true,
    mrz_composite_check_valid:  true,
    mrz_line1_parse_valid:      true,
    mrz_country_valid:          true,
    mrz_visual_passport_match:  true,
    mrz_visual_dob_match:       true,
    mrz_visual_expiry_match:    true,
    viz_mrz_crosscheck_valid:   true,
    document_not_expired:       true,
    dob_plausible:              true,
    expiry_after_dob:           true,
    file_number_format_valid:   true,
    pin_code_format_valid:      true,
    address_structure_valid:    true,
    rpo_address_mapping_valid:  true,
    front_back_consistency_valid: true
  },
  extractedData: {
    passport_number: 'A1234567',
    date_of_birth:   '1990-01-01',
    expiry_date:     '2030-01-01',
    file_number:     'MAA1234567890',
    rpo_code:        'MAA',
    parsed_address:  { pin_code: '600040', city: 'CHENNAI', state: 'TAMIL NADU' }
  },
  extractedFeatures: {
    mrz: {
      line1: 'P<INDSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<',
      line2: 'A12345670IND9001011M3001011<<<<<<<<<<<<<<<6',
      passport_number: 'A1234567',
      nationality: 'IND',
      date_of_birth_raw: '900101',
      expiry_date_raw:   '300101',
      sex: 'M',
      checksum_details: {},
      composite_check_applicable: true
    },
    visual:      { date_of_birth_raw: '1990-01-01', passport_number_raw: 'A1234567', expiry_date_raw: '2030-01-01' },
    back_page:   { file_number_raw: 'MAA1234567890', address_block_raw: '...', parsed_address: {} },
    inferred:    { rpo_code: 'MAA' },
    integrity:   {}
  }
};

/** Returns a fresh deps object; individual keys can be overridden. */
function makeDeps(overrides = {}) {
  return {
    readFileFn:               async ()          => Buffer.from('fake-image-bytes'),
    extractPassportDataFn:    async ()          => ({ ...MOCK_OCR_RESULT }),
    runValidationFn:          ()                => ({ ...MOCK_VALIDATION }),
    selectValidationResultFn: (primary)         => primary,
    shouldUseLlmFallbackFn:   ()                => false,
    runLlmFallbackFn:         async ()          => null,
    buildFallbackTraceFn:     ()                => null,
    assessOcrImageQualityFn:  ()                => ({ ...MOCK_QUALITY_OK }),
    ...overrides
  };
}

// ── Normal processing path ────────────────────────────────────────────────────

test('processPassportJob returns the correct top-level result shape', async () => {
  const result = await processPassportJob(makeJob(), makeDeps());

  assert.strictEqual(result.job_id,              'job_TEST01');
  assert.strictEqual(result.verification_status, 'PASSED');
  assert.strictEqual(result.integrity_score,     95);
  assert.strictEqual(result.integrity_tier,      'HIGH');
  assert.strictEqual(result.review_required,     false);
  assert.ok(Array.isArray(result.failed_checks), 'failed_checks must be an array');
  assert.ok('integrity_flags' in result,         'integrity_flags must be present');
  assert.ok('extracted_data'  in result,         'extracted_data must be present');
  assert.ok('extracted_features' in result,      'extracted_features must be present');
  assert.ok('google_ocr_raw'  in result,         'google_ocr_raw must be present');
});

test('processPassportJob includes non-negative processing_metrics', async () => {
  const result = await processPassportJob(makeJob(), makeDeps());

  const { queue_wait_ms, sdk_extraction_ms, internal_validation_ms } = result.processing_metrics;
  assert.ok(typeof queue_wait_ms        === 'number' && queue_wait_ms        >= 0);
  assert.ok(typeof sdk_extraction_ms    === 'number' && sdk_extraction_ms    >= 0);
  assert.ok(typeof internal_validation_ms === 'number' && internal_validation_ms >= 0);
});

test('processPassportJob reports llm_fallback.used=false when LLM is skipped', async () => {
  const result = await processPassportJob(makeJob(), makeDeps());

  assert.deepStrictEqual(result.extracted_features.llm_fallback, {
    used:      false,
    reason:    null,
    retryable: false
  });
  assert.strictEqual(result.fallback_trace, null);
  assert.strictEqual(result.llm_fallback,   null);
});

// ── File I/O ──────────────────────────────────────────────────────────────────

test('processPassportJob reads both front and back image files', async () => {
  const readPaths = [];
  const deps = makeDeps({
    readFileFn: async (p) => { readPaths.push(p); return Buffer.from('bytes'); }
  });

  await processPassportJob(makeJob(), deps);

  assert.deepStrictEqual(
    readPaths.sort(),
    [JOB_DATA.back.path, JOB_DATA.front.path].sort()
  );
});

test('processPassportJob passes base64 strings and correct metadata to OCR', async () => {
  let capturedFront = null;
  let capturedBack  = null;

  const deps = makeDeps({
    extractPassportDataFn: async (front, back) => {
      capturedFront = front;
      capturedBack  = back;
      return MOCK_OCR_RESULT;
    }
  });

  await processPassportJob(makeJob(), deps);

  assert.strictEqual(capturedFront.mimetype,     'image/jpeg');
  assert.strictEqual(capturedFront.originalname, 'front.jpg');
  assert.strictEqual(typeof capturedFront.dataBase64, 'string', 'front dataBase64 must be a string');

  assert.strictEqual(capturedBack.mimetype,      'image/jpeg');
  assert.strictEqual(capturedBack.originalname,  'back.jpg');
  assert.strictEqual(typeof capturedBack.dataBase64,  'string', 'back dataBase64 must be a string');
});

test('processPassportJob propagates readFile errors so BullMQ can retry', async () => {
  const deps = makeDeps({
    readFileFn: async () => { throw new Error('ENOENT: no such file or directory'); }
  });

  await assert.rejects(
    () => processPassportJob(makeJob(), deps),
    (err) => {
      assert.match(err.message, /ENOENT/);
      return true;
    }
  );
});

test('processPassportJob queue_wait_ms is clamped to 0 when clock jitter occurs', async () => {
  // Simulate processedOn slightly earlier than timestamp (system clock jitter).
  const job = makeJob({
    timestamp:   Date.now() + 200, // future timestamp
    processedOn: Date.now()
  });
  const result = await processPassportJob(job, makeDeps());
  assert.ok(result.processing_metrics.queue_wait_ms >= 0, 'must never be negative');
});

// ── LLM fallback path ─────────────────────────────────────────────────────────

test('processPassportJob triggers and records LLM fallback when needed', async () => {
  let llmCalled = false;

  const mockLlmResult = {
    status: 'success',
    model:  'llama-3.3-70b-versatile',
    extracted: {
      passport_number: 'A1234567',
      date_of_birth:   '1990-01-01',
      expiry_date:     '2030-01-01',
      file_number:     null,
      address:         null,
      structured: {
        front: { passport_number: 'A1234567', date_of_birth: '1990-01-01', expiry_date: '2030-01-01', surname: null, given_names: null },
        back:  { file_number: null, address_block: null },
        mrz:   { line1: null, line2: null, passport_number: 'A1234567', date_of_birth_raw: null, expiry_date_raw: null }
      }
    }
  };

  const mockTrace = { triggered: true, reason: 'initial validation was weak' };

  const deps = makeDeps({
    shouldUseLlmFallbackFn: () => true,
    runLlmFallbackFn:       async () => { llmCalled = true; return mockLlmResult; },
    buildFallbackTraceFn:   () => mockTrace
  });

  const result = await processPassportJob(makeJob(), deps);

  assert.ok(llmCalled, 'LLM fallback should have been invoked');
  assert.strictEqual(result.extracted_features.llm_fallback.used,  true);
  assert.strictEqual(result.extracted_features.llm_fallback.model, 'llama-3.3-70b-versatile');
  assert.deepStrictEqual(result.fallback_trace, mockTrace);
  assert.deepStrictEqual(result.llm_fallback,   mockLlmResult);
});

test('processPassportJob skips LLM when shouldUseLlmFallback returns false', async () => {
  let llmCalled = false;
  const deps = makeDeps({
    shouldUseLlmFallbackFn: () => false,
    runLlmFallbackFn:       async () => { llmCalled = true; return null; }
  });

  await processPassportJob(makeJob(), deps);
  assert.strictEqual(llmCalled, false, 'LLM must not run when not needed');
});

test('processPassportJob prefers second-pass result when it scores higher', async () => {
  const weakValidation  = { ...MOCK_VALIDATION, integrityScore: 50, verificationStatus: 'FAILED' };
  const strongValidation = { ...MOCK_VALIDATION, integrityScore: 90, verificationStatus: 'PASSED' };

  let runValidationCallCount = 0;
  const mockLlmResult = {
    status: 'success',
    model: 'llama-3.3-70b-versatile',
    extracted: {
      passport_number: 'A1234567', date_of_birth: '1990-01-01', expiry_date: '2030-01-01',
      file_number: null, address: null,
      structured: {
        front: { passport_number: 'A1234567', date_of_birth: '1990-01-01', expiry_date: '2030-01-01', surname: null, given_names: null },
        back:  { file_number: null, address_block: null },
        mrz:   { line1: null, line2: null, passport_number: 'A1234567', date_of_birth_raw: null, expiry_date_raw: null }
      }
    }
  };

  const deps = makeDeps({
    runValidationFn:          () => runValidationCallCount++ === 0 ? weakValidation : strongValidation,
    selectValidationResultFn: (primary, fallback) => {
      // Mirrors real selectValidationResult: pick higher score
      if (!fallback) return primary;
      return fallback.integrityScore > primary.integrityScore ? fallback : primary;
    },
    shouldUseLlmFallbackFn:   () => true,
    runLlmFallbackFn:         async () => mockLlmResult,
    buildFallbackTraceFn:     () => ({ triggered: true })
  });

  const result = await processPassportJob(makeJob(), deps);

  assert.strictEqual(result.verification_status, 'PASSED');
  assert.strictEqual(result.integrity_score,     90);
  assert.strictEqual(runValidationCallCount,     2, 'runValidation should run twice (first + second pass)');
});

test('processPassportJob returns REUPLOAD_REQUIRED when OCR image quality is insufficient', async () => {
  let validationCalled = false;
  let llmCalled = false;

  const deps = makeDeps({
    assessOcrImageQualityFn: () => ({
      acceptable: false,
      front: {
        acceptable: false,
        issues: ['FRONT_MRZ_UNREADABLE'],
        metrics: { char_count: 12, extraction_strong: false }
      },
      back: {
        acceptable: true,
        issues: [],
        metrics: { char_count: 120, extraction_strong: true }
      },
      user_message: 'Front image needs to be retaken. The MRZ strip at the bottom of the front page is not readable. Flatten the passport and avoid covering that area.',
      issue_details: [
        {
          code: 'FRONT_MRZ_UNREADABLE',
          message: 'The MRZ strip at the bottom of the front page is not readable. Flatten the passport and avoid covering that area.'
        }
      ]
    }),
    runValidationFn: () => { validationCalled = true; return MOCK_VALIDATION; },
    shouldUseLlmFallbackFn: () => true,
    runLlmFallbackFn: async () => { llmCalled = true; return null; }
  });

  const result = await processPassportJob(makeJob(), deps);

  assert.strictEqual(result.verification_status, 'REUPLOAD_REQUIRED');
  assert.strictEqual(result.integrity_score, null);
  assert.strictEqual(result.extracted_data, null);
  assert.ok(result.image_quality);
  assert.match(result.user_message, /Front image needs to be retaken/i);
  assert.strictEqual(result.processing_metrics.internal_validation_ms, 0);
  assert.strictEqual(validationCalled, false);
  assert.strictEqual(llmCalled, false);
  assert.deepStrictEqual(result.extracted_features.llm_fallback, {
    used: false,
    reason: 'skipped_due_to_image_quality',
    retryable: false
  });
});

// ── cleanupTempFiles ──────────────────────────────────────────────────────────

test('cleanupTempFiles resolves without error when given an empty array', async () => {
  await assert.doesNotReject(() => cleanupTempFiles([]));
});

test('cleanupTempFiles does not throw when unlink fails (ENOENT)', async () => {
  // Pass a path that definitely does not exist. cleanupTempFiles must swallow
  // the error and resolve normally — missed cleanup is non-fatal.
  const nonExistentPath = '/this/path/does/not/exist/12345.jpg';
  await assert.doesNotReject(() => cleanupTempFiles([nonExistentPath]));
});

test('cleanupTempFiles deletes real temp files successfully', async (t) => {
  const { writeFile, unlink: fsUnlink, access } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  // Create two real temp files.
  const p1 = join(tmpdir(), `pv_test_cleanup_1_${Date.now()}.tmp`);
  const p2 = join(tmpdir(), `pv_test_cleanup_2_${Date.now()}.tmp`);
  await Promise.all([writeFile(p1, 'a'), writeFile(p2, 'b')]);

  // Register teardown in case the assertion fails.
  t.after(async () => {
    await Promise.allSettled([fsUnlink(p1), fsUnlink(p2)]);
  });

  await cleanupTempFiles([p1, p2]);

  // Both files should now be gone.
  await assert.rejects(() => access(p1), 'p1 should have been deleted');
  await assert.rejects(() => access(p2), 'p2 should have been deleted');
});
