import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldUseLlmFallback,
  normalizeLlmExtraction,
  selectMrzLine2,
  buildFallbackTrace
} from '../src/services/llmFallback.js';

test('shouldUseLlmFallback returns false when no API key is configured', () => {
  const previousKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

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
    if (previousKey) {
      process.env.GROQ_API_KEY = previousKey;
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
