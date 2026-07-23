/**
 * Tier-2 OCR image quality assessment.
 *
 * Runs after Google Vision OCR and before the integrity pipeline. Detects
 * unreadable or unsupported images early so the client can re-upload instead
 * of waiting for validation/LLM fallback on hopeless input.
 */

const ISSUE_MESSAGES = {
  OCR_TEXT_TOO_SHORT:
    'Very little text was detected. Ensure the full passport page is visible, in focus, and well lit.',
  OCR_CONFIDENCE_LOW:
    'Text in the photo could not be read reliably. Retake in brighter, even light and hold the camera steady.',
  FRONT_MRZ_UNREADABLE:
    'The front image does not contain a complete MRZ line 2. Retake the front passport image with the MRZ strip fully visible and unobstructed.',
  FRONT_PASSPORT_CONTENT_MISSING:
    'Could not detect passport content on the front page. Upload a clear photo of the Indian passport front.',
  BACK_TEXT_UNREADABLE:
    'Very little text was detected on the back page. Retake with the full address section visible.',
  BACK_ANCHORS_MISSING:
    'Could not read the file number, address, or PIN on the back page. Retake the back page clearly.'
};

const THRESHOLDS = {
  front: {
    minCharCount: 80,
    minCharCountHard: 50,
    minAvgConfidence: 0.78,
    minAvgConfidenceHard: 0.65,
    minWordsForConfidence: 5
  },
  back: {
    minCharCount: 60,
    minCharCountHard: 40,
    minAvgConfidence: 0.75,
    minAvgConfidenceHard: 0.65,
    minWordsForConfidence: 5
  }
};

/**
 * Walks a Vision fullTextAnnotation and aggregates per-word confidence.
 *
 * @param {object|null|undefined} fullTextAnnotation
 * @returns {{ wordCount: number, avgConfidence: number|null, minConfidence: number|null }}
 */
export function extractVisionTextMetrics(fullTextAnnotation) {
  const confidences = [];

  for (const page of fullTextAnnotation?.pages || []) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          if (typeof word.confidence === 'number') {
            confidences.push(word.confidence);
          }
        }
      }
    }
  }

  if (confidences.length === 0) {
    return { wordCount: 0, avgConfidence: null, minConfidence: null };
  }

  const sum = confidences.reduce((total, value) => total + value, 0);
  return {
    wordCount: confidences.length,
    avgConfidence: sum / confidences.length,
    minConfidence: Math.min(...confidences)
  };
}

function countNonWhitespaceChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function uniqueIssues(issues) {
  return [...new Set(issues)];
}

function buildUserMessage(frontResult, backResult) {
  const failingPages = [];
  if (!frontResult.acceptable) failingPages.push('front');
  if (!backResult.acceptable) failingPages.push('back');

  const allIssues = uniqueIssues([
    ...frontResult.issues,
    ...backResult.issues
  ]);

  const detail = allIssues
    .map((code) => ISSUE_MESSAGES[code])
    .filter(Boolean)
    .join(' ');

  if (failingPages.length === 2) {
    return `Both passport images need to be retaken. ${detail}`;
  }

  if (failingPages.length === 1) {
    const pageLabel = failingPages[0] === 'front' ? 'Front' : 'Back';
    return `${pageLabel} image needs to be retaken. ${detail}`;
  }

  return detail || 'Please retake the passport photos and try again.';
}

function assessConfidence(metrics, pageKey, issues) {
  const thresholds = THRESHOLDS[pageKey];
  const { wordCount, avgConfidence } = metrics;

  if (wordCount < thresholds.minWordsForConfidence || avgConfidence === null) {
    return;
  }

  if (avgConfidence < thresholds.minAvgConfidenceHard) {
    issues.push('OCR_CONFIDENCE_LOW');
    return;
  }

  if (avgConfidence < thresholds.minAvgConfidence) {
    issues.push('OCR_CONFIDENCE_LOW');
  }
}

/**
 * @param {object} params
 * @param {string} params.text - Raw OCR text for the page
 * @param {object} params.normalized - Normalised page slice from extractPassportData
 * @param {{ wordCount: number, avgConfidence: number|null, minConfidence: number|null }} params.metrics
 * @param {'front'|'back'} params.page
 */
export function assessPageQuality({ text, normalized, metrics, page }) {
  const thresholds = THRESHOLDS[page];
  const charCount = countNonWhitespaceChars(text);
  const issues = [];

  if (page === 'front') {
    const front = normalized?.front || normalized || {};
    const hasMrzLine2 = Boolean(front.mrz_line2 && !String(front.mrz_line2).trim().startsWith('P<'));
    const hasMrz = Boolean(front.mrz_line1 || hasMrzLine2);
    const hasPassport = Boolean(front.passport_number || normalized?.passport_number);
    const hasDob = Boolean(
      front.date_of_birth ||
      front.visual_raw?.date_of_birth ||
      normalized?.date_of_birth
    );
    const hasExpiry = Boolean(
      front.expiry_date ||
      front.visual_raw?.expiry_date ||
      normalized?.expiry_date
    );
    const hasMrzLine1 = Boolean(front.mrz_line1);
    const anchorCount = [hasMrzLine2, hasPassport, hasDob, hasExpiry].filter(Boolean).length;
    const extractionStrong = hasMrzLine2 && hasPassport && (hasDob || hasExpiry);

    const pageMetrics = {
      char_count: charCount,
      word_count: metrics.wordCount,
      avg_confidence: metrics.avgConfidence,
      min_confidence: metrics.minConfidence,
      anchors_found: anchorCount,
      extraction_strong: extractionStrong,
      has_mrz_line1: hasMrzLine1,   // name line — P<IND...
      has_mrz_line2: hasMrzLine2,   // numeric line — passport | DOB | expiry | checksums
      has_passport_number: hasPassport
    };

    if (extractionStrong) {
      if (
        metrics.wordCount >= thresholds.minWordsForConfidence &&
        metrics.avgConfidence !== null &&
        metrics.avgConfidence < thresholds.minAvgConfidenceHard
      ) {
        issues.push('OCR_CONFIDENCE_LOW');
      }

      return {
        acceptable: issues.length === 0,
        issues: uniqueIssues(issues),
        metrics: pageMetrics
      };
    }

    if (charCount < thresholds.minCharCountHard) {
      issues.push('OCR_TEXT_TOO_SHORT');
    } else if (charCount < thresholds.minCharCount) {
      issues.push('OCR_TEXT_TOO_SHORT');
    }

    assessConfidence(metrics, page, issues);

    if (!hasMrzLine2) {
      issues.push('FRONT_MRZ_UNREADABLE');
    }

    if (anchorCount < 2) {
      issues.push('FRONT_PASSPORT_CONTENT_MISSING');
    }

    return {
      acceptable: issues.length === 0,
      issues: uniqueIssues(issues),
      metrics: pageMetrics
    };
  }

  const back = normalized?.back || normalized || {};
  const hasFile = Boolean(back.file_number || normalized?.file_number);
  const hasAddress = Boolean(back.address_block || normalized?.address);
  const hasPin = /\b(?:PIN[:\s]*)?\d{6}\b/i.test(text);
  const hasBackPassport = Boolean(back.passport_number);
  const anchorCount = [hasFile, hasAddress, hasPin, hasBackPassport].filter(Boolean).length;
  const extractionStrong = anchorCount >= 2;

  const pageMetrics = {
    char_count: charCount,
    word_count: metrics.wordCount,
    avg_confidence: metrics.avgConfidence,
    min_confidence: metrics.minConfidence,
    anchors_found: anchorCount,
    extraction_strong: extractionStrong,
    has_file_number: hasFile,
    has_address: hasAddress,
    has_pin: hasPin
  };

  if (extractionStrong) {
    if (
      metrics.wordCount >= thresholds.minWordsForConfidence &&
      metrics.avgConfidence !== null &&
      metrics.avgConfidence < thresholds.minAvgConfidenceHard
    ) {
      issues.push('OCR_CONFIDENCE_LOW');
    }

    return {
      acceptable: issues.length === 0,
      issues: uniqueIssues(issues),
      metrics: pageMetrics
    };
  }

  if (charCount < thresholds.minCharCountHard) {
    issues.push('BACK_TEXT_UNREADABLE');
  } else if (charCount < thresholds.minCharCount) {
    issues.push('BACK_TEXT_UNREADABLE');
  }

  assessConfidence(metrics, page, issues);

  if (anchorCount < 1) {
    issues.push('BACK_ANCHORS_MISSING');
  }

  return {
    acceptable: issues.length === 0,
    issues: uniqueIssues(issues),
    metrics: pageMetrics
  };
}

/**
 * Evaluates whether OCR output from both pages is sufficient to proceed.
 *
 * @param {object} ocrResult - Output from extractPassportData()
 * @returns {{
 *   acceptable: boolean,
 *   front: { acceptable: boolean, issues: string[], metrics: object },
 *   back: { acceptable: boolean, issues: string[], metrics: object },
 *   user_message: string,
 *   issue_details: Array<{ code: string, message: string }>
 * }}
 */
export function assessOcrImageQuality(ocrResult) {
  const raw = ocrResult?.raw?.google_vision || {};
  const emptyMetrics = { wordCount: 0, avgConfidence: null, minConfidence: null };

  const front = assessPageQuality({
    text: raw.front || '',
    normalized: ocrResult,
    metrics: raw.front_meta || emptyMetrics,
    page: 'front'
  });

  const back = assessPageQuality({
    text: raw.back || '',
    normalized: ocrResult,
    metrics: raw.back_meta || emptyMetrics,
    page: 'back'
  });

  const acceptable = front.acceptable && back.acceptable;
  const allIssueCodes = uniqueIssues([...front.issues, ...back.issues]);

  return {
    acceptable,
    front,
    back,
    user_message: acceptable ? null : buildUserMessage(front, back),
    issue_details: allIssueCodes.map((code) => ({
      code,
      message: ISSUE_MESSAGES[code] || code
    }))
  };
}
