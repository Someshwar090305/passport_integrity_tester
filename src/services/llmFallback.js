import 'dotenv/config';
import { pick, cleanMrzLine, normalizeDateString } from '../utils/helpers.js';

const MODEL_POOL = [
  process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant'
];
const RATE_LIMIT_ERROR_CODES = new Set([429, 403]);

function isLikelyMrzLine2(raw) {
  const normalized = cleanMrzLine(raw);
  if (!normalized) return false;
  return /^[A-Z0-9<]{28,44}$/.test(normalized) && !normalized.startsWith('P<');
}

export function selectMrzLine2(line1, line2) {
  const candidateLine2 = cleanMrzLine(line2);
  if (isLikelyMrzLine2(candidateLine2)) return candidateLine2;

  const candidateLine1 = cleanMrzLine(line1);
  if (isLikelyMrzLine2(candidateLine1)) return candidateLine1;

  return candidateLine2 || candidateLine1 || null;
}

// Exported so it can be unit-tested directly.
export function extractJsonFromText(text) {
  if (!text) return null;

  try {
    const trimmed = String(text).trim();
    const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }

    return JSON.parse(trimmed);
  } catch {
    // LLM returned text that could not be parsed as JSON.
    // Return null; the caller will convert this to a structured error response.
    return null;
  }
}

export function shouldUseLlmFallback(ocrResult, validationResult) {
  if (!process.env.GROQ_API_KEY) {
    return false;
  }

  // Respect the explicit opt-out flag. Checked here (not inside runLlmFallback)
  // so the worker never enters the fallback branch and no misleading
  // "Triggering LLM fallback" log is emitted when the feature is disabled.
  if (process.env.GROQ_FALLBACK_DISABLED === 'true') {
    return false;
  }

  const hasRequiredText = Boolean(
    ocrResult?.raw?.google_vision?.front || ocrResult?.raw?.google_vision?.back
  );

  const engineLooksWeak =
    validationResult?.verificationStatus === 'FAILED' ||
    !validationResult?.extractedData?.passport_number ||
    !validationResult?.extractedData?.date_of_birth ||
    !validationResult?.extractedData?.expiry_date;

  return hasRequiredText && engineLooksWeak;
}

export function buildFallbackTrace(initialValidation, llmFallback, finalValidation, llmInput) {
  const firstPass = {
    verification_status: initialValidation?.verificationStatus || null,
    integrity_flags: initialValidation?.integrityFlags || null,
    extracted_data: initialValidation?.extractedData || null
  };

  const llmMrzLine2 =
    llmInput?.front?.mrz_line2 ||
    llmInput?.mrz?.line2 ||
    llmInput?.mrz_line2 ||
    llmFallback?.extracted?.structured?.mrz?.line2 ||
    null;
  const initialAddress = initialValidation?.extractedFeatures?.back_page?.address_block_raw || null;

  const updatedFields = {
    passport_number: {
      before: initialValidation?.extractedData?.passport_number || null,
      after: finalValidation?.extractedData?.passport_number || null,
      changed: (initialValidation?.extractedData?.passport_number || null) !== (finalValidation?.extractedData?.passport_number || null)
    },
    date_of_birth: {
      before: initialValidation?.extractedData?.date_of_birth || null,
      after: finalValidation?.extractedData?.date_of_birth || null,
      changed: (initialValidation?.extractedData?.date_of_birth || null) !== (finalValidation?.extractedData?.date_of_birth || null)
    },
    expiry_date: {
      before: initialValidation?.extractedData?.expiry_date || null,
      after: finalValidation?.extractedData?.expiry_date || null,
      changed: (initialValidation?.extractedData?.expiry_date || null) !== (finalValidation?.extractedData?.expiry_date || null)
    },
    file_number: {
      before: initialValidation?.extractedData?.file_number || null,
      after: finalValidation?.extractedData?.file_number || null,
      changed: (initialValidation?.extractedData?.file_number || null) !== (finalValidation?.extractedData?.file_number || null)
    },
    mrz_line2: {
      before: initialValidation?.extractedFeatures?.mrz?.line2 || null,
      after: llmMrzLine2,
      changed: Boolean(llmMrzLine2) && (initialValidation?.extractedFeatures?.mrz?.line2 || null) !== llmMrzLine2
    },
    address: {
      before: initialAddress,
      after: llmFallback?.extracted?.address || null,
      changed: Boolean(llmFallback?.extracted?.address) && initialAddress !== llmFallback?.extracted?.address
    }
  };

  return {
    triggered: true,
    reason: 'initial validation was weak',
    first_pass: firstPass,
    llm_action: {
      status: llmFallback?.status || 'not_run',
      model: llmFallback?.model || null,
      fields_updated: updatedFields
    },
    second_pass: {
      verification_status: finalValidation?.verificationStatus || null,
      integrity_flags: finalValidation?.integrityFlags || null,
      extracted_data: finalValidation?.extractedData || null
    }
  };
}

export function normalizeLlmExtraction(raw) {
  const passportNumber = pick(raw?.passport_number, raw?.passportNo, raw?.passport_no, null);
  const dateOfBirth = normalizeDateString(
    pick(raw?.date_of_birth, raw?.dob, raw?.birth_date, null)
  );
  const expiryDate = normalizeDateString(
    pick(raw?.expiry_date, raw?.expiry, raw?.expiration_date, null)
  );
  const fileNumber = pick(raw?.file_number, raw?.fileNo, raw?.application_number, null);
  const address = pick(raw?.address, raw?.address_block, null);
  const surname = pick(raw?.surname, raw?.last_name, null);
  const givenNames = pick(raw?.given_names, raw?.first_name, raw?.givenName, null);
  const mrzLine1 = pick(raw?.mrz_line1, raw?.mrz?.line1, null);
  const mrzLine2 = selectMrzLine2(mrzLine1, pick(raw?.mrz_line2, raw?.mrz?.line2, null));

  return {
    passport_number: passportNumber,
    date_of_birth: dateOfBirth,
    expiry_date: expiryDate,
    country: pick(raw?.country, raw?.nationality, raw?.country_code, null),
    file_number: fileNumber,
    address,
    surname,
    given_names: givenNames,
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    structured: {
      front: {
        passport_number: passportNumber,
        date_of_birth: dateOfBirth,
        expiry_date: expiryDate,
        surname,
        given_names: givenNames
      },
      back: {
        file_number: fileNumber,
        address_block: address
      },
      mrz: {
        line2: mrzLine2,
        line1: mrzLine1,
        passport_number: passportNumber,
        date_of_birth_raw: raw?.date_of_birth_raw || null,
        expiry_date_raw: raw?.expiry_date_raw || null
      }
    }
  };
}

export async function runLlmFallback(ocrResult) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (process.env.GROQ_FALLBACK_DISABLED === 'true') {
    return {
      status: 'disabled',
      message: 'LLM fallback disabled by configuration'
    };
  }

  const prompt = [
    'You are extracting passport fields from OCR text.',
    'Return ONLY valid JSON with the exact schema below.',
    'Do not guess. If a field is not clearly present, set it to null.',
    'If you can read the two MRZ lines, put the second line in mrz_line2 and the first line in mrz_line1.',
    '{',
    '  "passport_number": "string|null",',
    '  "surname": "string|null",',
    '  "given_names": "string|null",',
    '  "date_of_birth": "YYYY-MM-DD|null",',
    '  "expiry_date": "YYYY-MM-DD|null",',
    '  "country": "string|null",',
    '  "file_number": "string|null",',
    '  "address": "string|null",',
    '  "mrz_line1": "string|null",',
    '  "mrz_line2": "string|null",',
    '  "confidence": 0.0',
    '}',
    '',
    'OCR text from front page:',
    ocrResult?.raw?.google_vision?.front || '',
    '',
    'OCR text from back page:',
    ocrResult?.raw?.google_vision?.back || ''
  ].join('\n');

  try {
    let lastError = null;

    for (const modelName of MODEL_POOL) {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You extract passport fields from OCR text and return only valid JSON.'
            },
            {
              role: 'user',
              content: prompt
            }
          ]
        })
      });

      if (response.ok) {
        const payload = await response.json();
        const rawText = payload?.choices?.[0]?.message?.content || '';

        if (!rawText) {
          return {
            status: 'error',
            message: 'LLM response did not include any text content'
          };
        }

        const extracted = extractJsonFromText(rawText);

        if (!extracted) {
          return {
            status: 'error',
            message: 'LLM response could not be parsed as JSON',
            model: modelName
          };
        }

        const normalized = normalizeLlmExtraction(extracted);

        return {
          status: 'success',
          extracted: normalized,
          raw: payload,
          model: modelName
        };
      }

      const errorText = await response.text();
      lastError = {
        status: 'error',
        message: `LLM request failed: ${response.status} ${errorText}`,
        retryable: RATE_LIMIT_ERROR_CODES.has(response.status),
        model: modelName
      };

      if (!RATE_LIMIT_ERROR_CODES.has(response.status)) {
        break;
      }
    }

    return lastError || {
      status: 'error',
      message: 'LLM fallback failed without a response'
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown LLM error'
    };
  }
}
