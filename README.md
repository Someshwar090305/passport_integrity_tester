# Passport Validator

A Node.js service for validating Indian passport images by combining OCR, a layered deterministic integrity pipeline, and an optional Vertex AI (Gemini 2.5 Flash) LLM fallback. The API accepts front/back passport images, queues verification jobs asynchronously via BullMQ + Redis, and returns structured results including an integrity score, tier, and full fallback trace.

## What the Service Does

- Accepts `front_image` and `back_image` via `POST /api/v1/jobs/verify-passport`
- Writes uploaded images to a local temp directory (keeps Redis memory lean)
- Queues the job for background processing using BullMQ (3 retry attempts with exponential backoff)
- Runs Google Cloud Vision OCR on both pages in parallel
  - Front page: extracts MRZ lines, passport number, DOB, expiry, date of issue, and place of issue
  - Back page: extracts file number, address, and barcode-adjacent passport number (no MRZ extraction — prevents false positives)
- Runs a 5-layer deterministic integrity pipeline and computes a weighted score
- Optionally invokes a Vertex AI (Gemini 2.5 Flash) LLM fallback when the first pass is weak, then re-validates with the corrected data
- **Skips the LLM** when the only failure is an expired passport and all data fields were already successfully extracted — the LLM cannot un-expire a document
- Returns `202 Accepted` immediately; poll `GET /api/v1/jobs/:jobId` for results
- Emits structured JSON logs to stdout/stderr (filterable by `LOG_LEVEL`)

## Tech Stack

- Node.js (ESM)
- Express 5
- BullMQ + Redis (ioredis)
- Google Cloud Vision (`@google-cloud/vision`)
- Google Vertex AI (`@google-cloud/vertexai`) — Gemini 2.5 Flash LLM fallback
- Multer
- dotenv
- ulid

## Project Structure

```text
src/
  api/
    app.js                  — Express app, middleware wiring
    middleware.js           — API key auth + in-memory rate limiter
    routes/jobs.js          — POST /verify-passport, GET /:jobId
  providers/
    googleVisionClient.js   — Vision API client, page-specific OCR normalizers
    ocrClient.js            — Re-export facade for the OCR provider
  queue/
    passportQueue.js        — BullMQ queue + Redis connection
  services/
    validationEngine.js     — Orchestrates all validators, builds integrity flags
    integrityScoring.js     — Weighted scoring, tier assignment
    llmFallback.js          — Vertex AI fallback trigger, normalization, trace builder
  utils/
    helpers.js              — Shared utilities: pick, yyMmDdToIso, cleanMrzLine, normalizeDateString
    logger.js               — Structured JSON logger (respects LOG_LEVEL)
  validators/
    mrzChecksum.js          — MRZ check digit computation and validation
    mrzIntegrity.js         — Full MRZ integrity checks (checksums, composite, visual cross-matches)
    temporalIntegrity.js    — Expiry, DOB plausibility, expiry-after-DOB
    backPageIntegrity.js    — File number format, PIN format, address structure
    documentConsistency.js  — Cross-page consistency: passport number, MRZ optional data, RPO alignment
    visualCrosscheck.js     — Visual DOB vs MRZ DOB comparison
    rpoMapping.js           — RPO code extraction, address parsing, region mapping
  worker/
    passportWorker.js       — BullMQ worker: OCR → validate → LLM fallback → cleanup
  server.js
scripts/
  run-sample-cases.js       — Batch runner for all sample passport folders
test/
  googleVisionClient.test.js
  validationEngine.test.js
  validators.test.js
  llmFallback.test.js
  mrzIntegrity.test.js
  temporalIntegrity.test.js
  backPageIntegrity.test.js
  documentConsistency.test.js
  integrityScoring.test.js
  passportWorker.test.js
```

## Prerequisites

- Node.js 18+
- Redis server running locally or remotely
- Google Cloud service account JSON with **Cloud Vision API** and **Vertex AI API** access
- `GOOGLE_APPLICATION_CREDENTIALS` pointing to the credentials file
- `GOOGLE_CLOUD_PROJECT` set to your GCP project ID
- Vertex AI API enabled in your project: `gcloud services enable aiplatform.googleapis.com`

## Installation

```bash
npm install
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your values.

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379

# Google Cloud credentials — used by both Cloud Vision (OCR) and Vertex AI (LLM fallback).
# Point this to your service account JSON key file.
GOOGLE_APPLICATION_CREDENTIALS=./credentials/your-service-account.json

# The GCP project ID that hosts your Cloud Vision and Vertex AI services.
GOOGLE_CLOUD_PROJECT=your-gcp-project-id

# Vertex AI region — Gemini 2.5 models are available in us-central1.
# Override only if you have confirmed access to another region.
VERTEX_AI_LOCATION=us-central1

# Override the primary Gemini model (default: gemini-2.5-flash).
# VERTEX_AI_MODEL=gemini-2.5-flash

# Optional: API key authentication
# When set, all requests must include X-API-Key: <value> header.
# Leave unset to disable auth entirely.
API_KEY=

# Optional: in-memory rate limiter
RATE_LIMIT_WINDOW_MS=60000   # window duration in ms (default: 60 000)
RATE_LIMIT_MAX=60            # max requests per window per IP (default: 60)

# Optional: temp directory for uploaded images
# Defaults to the OS temp dir. Must be writable by both the API and worker.
UPLOAD_TEMP_DIR=

# Optional: log verbosity — debug | info | warn | error (default: info)
LOG_LEVEL=info

# Optional: disable LLM fallback without removing credentials
LLM_FALLBACK_DISABLED=false
```

## Running the Service

Three processes must be running: Redis, the API, and the worker.

### 1) Start Redis

```bash
docker run --name passport-redis -p 6379:6379 -d redis
```

### 2) Start the API

```bash
npm run dev:api
```

### 3) Start the worker

In a second terminal:

```bash
npm run dev:worker
```

### 4) Health check

```bash
curl http://localhost:3000/healthz
```

Expected response:

```json
{"status":"ok"}
```

## API

### `POST /api/v1/jobs/verify-passport`

Asynchronous. Accepts multipart form data, enqueues a background job, and returns a job ID immediately.

**Request fields**

| Field | Required | Type | Limit |
|---|---|---|---|
| `front_image` | ✅ | `image/jpeg` or `image/png` | 8 MB |
| `back_image` | ✅ | `image/jpeg` or `image/png` | 8 MB |

**Optional header** — if `API_KEY` is set in the environment:

```
X-API-Key: your_api_key
```

**Example**

```bash
curl -X POST http://localhost:3000/api/v1/jobs/verify-passport \
  -F "front_image=@./samples/Demo passport 1/front.jpg" \
  -F "back_image=@./samples/Demo passport 1/back.jpg"
```

**Response** — `202 Accepted`

```json
{
  "job_id": "job_01ABCDEF...",
  "status": "queued",
  "message": "Verification job accepted for background processing"
}
```

---

### `GET /api/v1/jobs/:jobId`

Poll until the job finishes.

| HTTP status | Meaning |
|---|---|
| `202 Accepted` | Job is still queued or processing |
| `200 OK` | Verification complete — body contains the full result |
| `500` | Job failed (body contains `failedReason`) |
| `404` | Job ID not found |

**Example completed response**

```json
{
  "job_id": "job_01ABCDEF...",
  "processing_metrics": {
    "queue_wait_ms": 1250,
    "sdk_extraction_ms": 1200,
    "internal_validation_ms": 35
  },
  "verification_status": "PASSED",
  "integrity_flags": {
    "mrz_checksums_valid": true,
    "mrz_composite_check_valid": true,
    "mrz_line1_parse_valid": true,
    "mrz_country_valid": true,
    "mrz_visual_passport_match": true,
    "mrz_visual_dob_match": true,
    "mrz_visual_expiry_match": true,
    "viz_mrz_crosscheck_valid": true,
    "document_not_expired": true,
    "dob_plausible": true,
    "expiry_after_dob": true,
    "file_number_format_valid": true,
    "pin_code_format_valid": true,
    "address_structure_valid": true,
    "rpo_address_mapping_valid": true,
    "front_back_consistency_valid": true
  },
  "integrity_score": 100,
  "integrity_tier": "HIGH",
  "review_required": false,
  "failed_checks": [],
  "extracted_data": {
    "passport_number": "A1234567",
    "date_of_birth": "1990-01-01",
    "expiry_date": "2030-01-01",
    "file_number": "MAA1234567890",
    "rpo_code": "MAA",
    "parsed_address": {
      "pin_code": "600040",
      "city": "CHENNAI",
      "state": "TAMIL NADU"
    }
  },
  "extracted_features": {
    "mrz": {
      "line1": "P<INDSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<",
      "line2": "A12345670IND9001011M3001011<<<<<<<<<<<<<<<6",
      "passport_number": "A1234567",
      "nationality": "IND",
      "date_of_birth_raw": "900101",
      "expiry_date_raw": "300101",
      "sex": "M",
      "checksum_details": {
        "passportNumber": true,
        "dateOfBirth": true,
        "expiryDate": true
      },
      "composite_check_applicable": true
    },
    "visual": {
      "date_of_birth_raw": "1990-01-01",
      "passport_number_raw": "A1234567",
      "expiry_date_raw": "2030-01-01"
    },
    "back_page": {
      "file_number_raw": "MAA1234567890",
      "address_block_raw": "12 Some Street, Chennai PIN 600040, Tamil Nadu, India",
      "parsed_address": {
        "pin_code": "600040",
        "city": "CHENNAI",
        "state": "TAMIL NADU"
      },
      "passport_number_raw": "A1234567"
    },
    "inferred": {
      "rpo_code": "MAA"
    },
    "llm_fallback": {
      "used": false,
      "reason": null,
      "retryable": false
    }
  },
  "fallback_trace": null
}
```

**Example with LLM fallback triggered**

When the first pass fails or yields incomplete data, the response includes a `fallback_trace`:

```json
{
  "fallback_trace": {
    "triggered": true,
    "reason": "initial validation was weak",
    "first_pass": {
      "verification_status": "FAILED",
      "integrity_flags": { "mrz_checksums_valid": false },
      "extracted_data": { "passport_number": null }
    },
    "llm_action": {
      "status": "success",
      "model": "gemini-2.5-flash",
      "fields_updated": {
        "passport_number": { "before": null, "after": "A1234567", "changed": true },
        "mrz_line2": { "before": null, "after": "A12345670IND...", "changed": true }
      }
    },
    "second_pass": {
      "verification_status": "PASSED",
      "integrity_flags": { "mrz_checksums_valid": true }
    }
  }
}
```

## Integrity Pipeline

The validation engine runs five layers in sequence:

| Layer | Checks |
|---|---|
| **1. MRZ integrity** | Checksum digits (passport, DOB, expiry), composite check digit (when full 44-char line is available), line 1 parse, country/nationality must be `IND`, visual vs MRZ cross-matches for passport number, DOB, and expiry |
| **2. Temporal integrity** | Passport not expired, DOB is plausible (between 1900 and today, max 120 years ago), expiry is after DOB |
| **3. Back-page integrity** | File number matches `[A-Z]{2,4}[0-9]{8,15}` format, PIN is 6-digit and non-zero-prefixed, address has sufficient structure |
| **4. Document consistency** | **Tier 1:** Passport number on back page vs MRZ-parsed passport number (primary cross-page anchor). **Tier 2:** MRZ optional data field (positions 28–41 of line 2) vs numeric portion of back-page file number — checksum-protected. Falls back to intra-front visual vs MRZ comparison when neither tier is applicable. RPO code from file number vs address region. |
| **5. RPO mapping** | File number prefix maps to the correct geographic region for the parsed address |

### Scoring and tiers

Each check carries a weight. Failing a check deducts that weight from a starting score of 100.

| Check | Severity | Weight |
|---|---|---|
| `mrz_checksums_valid` | critical | 20 |
| `document_not_expired` | critical | 15 |
| `mrz_visual_passport_match` | critical | 15 |
| `front_back_consistency_valid` | critical | 12 |
| `mrz_country_valid` | critical | 10 |
| `dob_plausible` | critical | 8 |
| `expiry_after_dob` | critical | 8 |
| `mrz_visual_dob_match` | medium | 12 |
| `mrz_visual_expiry_match` | medium | 10 |
| `rpo_address_mapping_valid` | medium | 10 |
| `mrz_composite_check_valid` | medium | 8 |
| `file_number_format_valid` | medium | 8 |
| `address_structure_valid` | medium | 8 |
| `pin_code_format_valid` | medium | 6 |
| `mrz_line1_parse_valid` | medium | 5 |
| `visual_dob_missing` *(synthetic)* | medium | 8 |

> **Note:** `viz_mrz_crosscheck_valid` appears in `integrity_flags` as a convenience alias for `mrz_visual_dob_match` but is **not scored independently** — doing so would double-count the same DOB mismatch. It is present in the response for API consumer convenience only.

> **Note:** Several checks are skipped when the corresponding data is absent (e.g. `mrz_composite_check_valid` is skipped when MRZ line 2 is shorter than 44 characters; `mrz_visual_dob_match` is skipped when OCR could not read a visual DOB). A skipped check does not deduct points. Instead, when visual DOB is absent a `visual_dob_missing` synthetic failure is recorded (−8 pts) and `review_required` is set to `true`.

| Tier | Score | Condition |
|---|---|---|
| `PASSED` / `HIGH` | ≥ 85 | No critical failures |
| `REVIEW_REQUIRED` / `MEDIUM` | 70–84 | No critical failures, but at least one medium failure or visual DOB missing |
| `REVIEW_REQUIRED` / `LOW` | 60–69 | No critical failures, score below 70 |
| `FAILED` / `REJECT` | < 60, or any critical failure | — |

## Visual ↔ MRZ Cross-check Integrity

The `mrz_visual_passport_match`, `mrz_visual_dob_match`, and `mrz_visual_expiry_match` checks compare what OCR reads visually from the printed page against the machine-readable zone (MRZ).

The OCR normalizer produces two separate data paths:

| Path | Field | Used for |
|---|---|---|
| `front.visual_raw.*` | What OCR read from the printed visual fields only — never overwritten by MRZ data | Cross-checks (`mrz_visual_*_match`) |
| `front.*` / `extracted_data.*` | MRZ-assisted (MRZ wins when present, visual is fallback) | Output / extracted data |

This split means that obscured or tampered visual fields genuinely fail the cross-check even when the MRZ remains intact. For example:

- A hidden passport number prefix → `mrz_visual_passport_match: false` → −15 pts (critical)
- An unreadable DOB → `visual_dob_missing` → −8 pts + `review_required: true`

The `extracted_features.visual` section in the response shows raw visual values, making it transparent exactly what OCR saw on the printed page vs what the MRZ says.

## MRZ Robustness

The pipeline handles several real-world OCR failure modes automatically:

| Failure | Detection | Recovery |
|---|---|---|
| OCR returns MRZ lines in swapped slots | Line 2 starts with `P<` and Line 1 does not — physically impossible for a correct pair | Lines are swapped before parsing |
| OCR truncates MRZ Line 2 (< 42 chars) | Detected as a ≥ 28-char alphanumeric/`<` string immediately after a `P<` line | Accepted as Line 2; checksums still validated on available fields |
| Garbled nationality field (`Y`, `1IN`, `<<<`) | Value does not match `/^[A-Z]{3}$/` | Treated as unreadable (not as a confirmed foreign nationality); no country penalty |

## Optional LLM Fallback

When `GOOGLE_CLOUD_PROJECT` is set, the worker runs the deterministic engine first and only calls Gemini when:

- The OCR raw text from at least one page is available, **and**
- The first-pass result is `FAILED`, **or** passport number / DOB / expiry are missing

**The LLM is skipped** when the first pass failed *only* because the passport is expired and all three key fields (passport number, DOB, expiry) were successfully extracted. An expired document has perfectly readable data; the LLM cannot change the expiry date.

The LLM receives the raw OCR text from both pages and returns structured JSON. That output is normalised into the same OCR shape and fed back through `runValidation()`. The better result (by score, then by status rank) is used. The full trace — first pass, LLM action, second pass — is included in the response.

Set `LLM_FALLBACK_DISABLED=true` to disable the fallback without removing credentials.

## Security

### API Key Authentication

Set `API_KEY` in your environment to require all clients to send `X-API-Key: <value>`. Requests without the correct key receive `401 Unauthorized`. Leave `API_KEY` unset to disable (default — **not recommended for production**).

### Rate Limiting

An in-memory sliding-window rate limiter is applied per client IP. Defaults are 60 requests per 60-second window. Override with `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`.

> **Note:** The rate limiter is single-process in-memory. If you run multiple API replicas behind a load balancer, replace it with a Redis-backed implementation (e.g. `rate-limiter-flexible`).

## Batch Sample Runner

Run all sample folders automatically without Postman:

```bash
npm run samples:run -- --base-url http://localhost:3000
```

Optional flags:

| Flag | Default | Description |
|---|---|---|
| `--base-url` | `http://localhost:3000` | API base URL |
| `--poll-interval-ms` | `2000` | How often to poll for results |
| `--timeout-ms` | `600000` | Max wait per case (10 min) |

The script auto-detects `front`/`back` images inside each subfolder of `samples/`. Files named `front.jpg`, `back.jpg`, `front.png`, or `back.png` are picked up directly; others are matched by common name patterns.

## Tests

```bash
npm test
```

Current coverage (65 tests, all passing):

- MRZ checksum and composite check digit computation
- MRZ line 1 and line 2 parsing and integrity checks
- MRZ line swap auto-detection and correction
- Truncated MRZ Line 2 extraction (< 42 chars from OCR)
- Garbled OCR nationality guard (no false country failures)
- Visual ↔ MRZ cross-check with `visual_raw` isolation (tampered field detection)
- Visual DOB vs MRZ DOB matching (multiple date formats)
- Temporal integrity (expiry, DOB plausibility)
- Back-page integrity (file number, PIN, address)
- Document consistency (visual vs MRZ passport number, MRZ optional data vs file number, RPO alignment)
- Integrity scoring (PASSED / REVIEW_REQUIRED / FAILED tiers)
- LLM fallback normalization, MRZ line selection, JSON extraction, fallback trace builder
- LLM skip when only failure is expired passport with complete data
- Google Vision OCR normalization, MRZ extraction, and `visual_raw` split
- Job processor (BullMQ job lifecycle, LLM path, temp-file cleanup)

## Logging

The service emits structured JSON to stdout (info/warn/debug) and stderr (error). Each line is a JSON object:

```json
{"time":"2026-07-20T08:00:00.000Z","level":"info","msg":"Job completed","job_id":"job_01ABC...","verification_status":"PASSED","integrity_score":100,"llm_used":false}
```

Set `LOG_LEVEL=debug` to see all log lines including per-field details.
