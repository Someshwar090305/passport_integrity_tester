import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldUseLlmFallback,
  normalizeLlmExtraction,
  selectMrzLine2,
  buildFallbackTrace,
  extractJsonFromText
} from '../src/services/llmFallback.js';

test('shouldUseLlmFallback returns false when no project is configured', () => {
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;

  try {
    const result = shouldUseLlmFallback(
      {
        front: { mrz_line2: 'P<IND...' },
        raw: { google_vision: { front: 'text', back: 'text' } }
      },
      {
        verificationStatus: 'FAILED',
        extractedData: {}
      }
    );

    assert.equal(result, false);
  } finally {
    if (previousProject) {
      process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    }
  }
});

test('normalizeLlmExtraction converts loose values to a stable output shape', () => {
  const normalized = normalizeLlmExtraction({
    passport_number: 'P1234567',
    date_of_birth: '12/08/1974',
    expiry_date: '15/04/2030',
    country: 'India',
    file_number: 'MAA1234567',
    address: 'Chennai, Tamil Nadu'
  });

  assert.equal(normalized.passport_number, 'P1234567');
  assert.equal(normalized.date_of_birth, '1974-08-12');
  assert.equal(normalized.expiry_date, '2030-04-15');
  assert.equal(normalized.country, 'India');
  assert.equal(normalized.file_number, 'MAA1234567');
  assert.equal(normalized.structured.front.passport_number, 'P1234567');
  assert.equal(normalized.structured.back.file_number, 'MAA1234567');
});

test('selectMrzLine2 ignores the first MRZ line and keeps the OCR second line', () => {
  const chosen = selectMrzLine2(
    'P<TWNLIN<<MEI<HUA<<<<<<<<<<<<<<<<<<<<<<<<<<<',
    '8888008505TWN8801018F1812291<<<<<'
  );

  assert.equal(chosen, '8888008505TWN8801018F1812291<<<<<');
});

test('buildFallbackTrace records the first-pass failure and the LLM field updates', () => {
  const trace = buildFallbackTrace(
    {
      verificationStatus: 'FAILED',
      integrityFlags: {
        mrz_checksums_valid: false,
        viz_mrz_crosscheck_valid: false,
        rpo_address_mapping_valid: true
      },
      extractedData: {
        passport_number: 'OLD123',
        date_of_birth: null,
        expiry_date: null,
        parsed_address: {
          pin_code: null,
          city: null
        }
      },
      extractedFeatures: {
        mrz: {
          line2: 'OLDMRZLINE'
        }
      }
    },
    {
      status: 'success',
      extracted: {
        passport_number: 'NEW123',
        date_of_birth: '1988-01-01',
        expiry_date: '2028-12-31',
        address: 'Some address',
        structured: {
          mrz: {
            line2: 'MRZLINE2'
          }
        }
      },
      model: 'llama-test'
    },
    {
      verificationStatus: 'PASSED',
      integrityFlags: {
        mrz_checksums_valid: true,
        viz_mrz_crosscheck_valid: true,
        rpo_address_mapping_valid: true
      },
      extractedData: {
        passport_number: 'NEW123',
        date_of_birth: '1988-01-01',
        expiry_date: '2028-12-31',
        parsed_address: {
          pin_code: '600064',
          city: 'CHENNAI'
        }
      }
    },
    {
      mrz_line2: 'MRZLINE2',
      file_number: 'FILE123',
      address: 'Some address'
    }
  );

  assert.equal(trace.first_pass.verification_status, 'FAILED');
  assert.equal(trace.triggered, true);
  assert.equal(trace.reason, 'initial validation was weak');
  assert.equal(trace.llm_action.status, 'success');
  assert.equal(trace.llm_action.fields_updated.passport_number.changed, true);
  assert.equal(trace.llm_action.fields_updated.mrz_line2.changed, true);
});

// ── C2: LLM_FALLBACK_DISABLED guard ───────────────────────────────────────────────

test('C2: shouldUseLlmFallback returns false when LLM_FALLBACK_DISABLED=true', () => {
  const previousProject  = process.env.GOOGLE_CLOUD_PROJECT;
  const previousDisabled = process.env.LLM_FALLBACK_DISABLED;

  process.env.GOOGLE_CLOUD_PROJECT  = 'test-project';
  process.env.LLM_FALLBACK_DISABLED = 'true';

  try {
    const result = shouldUseLlmFallback(
      { raw: { google_vision: { front: 'some text', back: 'some text' } } },
      { verificationStatus: 'FAILED', extractedData: {} }
    );
    assert.equal(result, false,
      'should return false when LLM_FALLBACK_DISABLED=true even with a project set');
  } finally {
    if (previousProject !== undefined) process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    else delete process.env.GOOGLE_CLOUD_PROJECT;
    if (previousDisabled !== undefined) process.env.LLM_FALLBACK_DISABLED = previousDisabled;
    else delete process.env.LLM_FALLBACK_DISABLED;
  }
});

test('C2: shouldUseLlmFallback returns true when LLM_FALLBACK_DISABLED is unset', () => {
  const previousProject  = process.env.GOOGLE_CLOUD_PROJECT;
  const previousDisabled = process.env.LLM_FALLBACK_DISABLED;

  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
  delete process.env.LLM_FALLBACK_DISABLED;

  try {
    const result = shouldUseLlmFallback(
      { raw: { google_vision: { front: 'some text', back: '' } } },
      { verificationStatus: 'FAILED', extractedData: {} }
    );
    assert.equal(result, true,
      'should return true when disabled flag is absent and conditions are met');
  } finally {
    if (previousProject !== undefined) process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    else delete process.env.GOOGLE_CLOUD_PROJECT;
    if (previousDisabled !== undefined) process.env.LLM_FALLBACK_DISABLED = previousDisabled;
  }
});

// ── C2b: expired-passport LLM skip optimisation ───────────────────────────────

test('C2b: shouldUseLlmFallback returns false when the only failure is an expired passport with complete data', () => {
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';

  try {
    const result = shouldUseLlmFallback(
      { raw: { google_vision: { front: 'some text', back: 'some text' } } },
      {
        verificationStatus: 'FAILED',
        extractedData: {
          passport_number: 'K0037575',
          date_of_birth: '1977-06-10',
          expiry_date: '2021-12-08'
        },
        failedChecks: [
          { code: 'document_not_expired', severity: 'critical', message: 'Passport is expired' }
        ]
      }
    );
    assert.equal(result, false,
      'LLM must not run when passport is expired but all data fields were extracted');
  } finally {
    if (previousProject !== undefined) process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    else delete process.env.GOOGLE_CLOUD_PROJECT;
  }
});

test('C2b: shouldUseLlmFallback returns true when passport is expired AND data is incomplete', () => {
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = 'test-project';

  try {
    // Expired passport but MRZ was also broken — data extraction failed too.
    // LLM should still run to try to recover the missing fields.
    const result = shouldUseLlmFallback(
      { raw: { google_vision: { front: 'some text', back: '' } } },
      {
        verificationStatus: 'FAILED',
        extractedData: {
          passport_number: null,
          date_of_birth: null,
          expiry_date: '2021-12-08'
        },
        failedChecks: [
          { code: 'document_not_expired', severity: 'critical', message: 'Passport is expired' }
        ]
      }
    );
    assert.equal(result, true,
      'LLM must still run when passport is expired but key data fields are missing');
  } finally {
    if (previousProject !== undefined) process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    else delete process.env.GOOGLE_CLOUD_PROJECT;
  }
});

// ── C3: extractJsonFromText parse-error handling ─────────────────────────

test('C3: extractJsonFromText returns null for bare malformed JSON', () => {
  const result = extractJsonFromText('this is not json at all');
  assert.equal(result, null, 'should return null, not throw SyntaxError');
});

test('C3: extractJsonFromText returns null for malformed JSON inside a code fence', () => {
  const result = extractJsonFromText('```json\n{ broken: json, }\n```');
  assert.equal(result, null, 'should return null when fenced content is invalid JSON');
});

test('C3: extractJsonFromText returns null for empty string', () => {
  assert.equal(extractJsonFromText(''), null);
  assert.equal(extractJsonFromText(null), null);
});

test('C3: extractJsonFromText correctly parses valid JSON object', () => {
  const result = extractJsonFromText('{"passport_number": "A1234567"}');
  assert.deepStrictEqual(result, { passport_number: 'A1234567' });
});

test('C3: extractJsonFromText extracts JSON from a code-fenced block', () => {
  const result = extractJsonFromText('```json\n{"passport_number": "B9876543"}\n```');
  assert.deepStrictEqual(result, { passport_number: 'B9876543' });
});
