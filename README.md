# Passport Validator

A Node.js service for validating Indian passport images by combining OCR, a layered deterministic integrity pipeline, and an optional Groq-backed LLM fallback. The API accepts front/back passport images, queues verification jobs asynchronously via BullMQ + Redis, and returns structured results including an integrity score, tier, and full fallback trace.

## What the Service Does

- Accepts `front_image` and `back_image` via `POST /api/v1/jobs/verify-passport`
- Writes uploaded images to a local temp directory (keeps Redis memory lean)
- Queues the job for background processing using BullMQ (3 retry attempts with exponential backoff)
- Runs Google Cloud Vision OCR on both pages in parallel
- Front page: extracts MRZ lines, passport number, DOB, and expiry
- Back page: extracts file number and address only (no MRZ extraction — prevents false positives)
- Runs a 5-layer deterministic integrity pipeline and computes a weighted score
- Optionally invokes a Groq LLM fallback when the first pass is weak, then re-validates with the corrected data
- Returns `202 Accepted` immediately; poll `GET /api/v1/jobs/:jobId` for results
- Emits structured JSON logs to stdout/stderr (filterable by `LOG_LEVEL`)

## Tech Stack

- Node.js (ESM)
- Express 5
- BullMQ + Redis (ioredis)
- Google Cloud Vision (`@google-cloud/vision`)
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
    llmFallback.js          — Groq fallback trigger, normalization, trace builder
  utils/
    helpers.js              — Shared utilities: pick, yyMmDdToIso, cleanMrzLine, normalizeDateString
    logger.js               — Structured JSON logger (respects LOG_LEVEL)
  validators/
    mrzChecksum.js          — MRZ check digit computation and validation
    mrzIntegrity.js         — Full MRZ integrity checks (checksums, composite, visual cross-matches)
    temporalIntegrity.js    — Expiry, DOB plausibility, expiry-after-DOB
    backPageIntegrity.js    — File number format, PIN format, address structure
    documentConsistency.js  — Visual passport number vs MRZ-encoded number, RPO alignment
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
```

## Prerequisites

- Node.js 18+
- Redis server running locally or remotely
- Google Cloud service account JSON with Vision API access
- `GOOGLE_APPLICATION_CREDENTIALS` pointing to the credentials file

## Installation

```bash
npm install
```

## Environment Variables

Copy `.env.example` to `.env` and fill in your values.

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
GOOGLE_APPLICATION_CREDENTIALS=./credentials/your-service-account.json

# Optional: Groq LLM fallback
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_FALLBACK_DISABLED=false

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
      "line1": "P<INDSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<",
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
      }
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
      "model": "llama-3.3-70b-versatile",
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
| **1. MRZ integrity** | Checksum digits (passport, DOB, expiry), composite check digit (when full 44-char line available), line 1 parse, country/nationality must be `IND`, visual vs MRZ passport number, DOB, and expiry cross-matches |
| **2. Temporal integrity** | Passport not expired, DOB is plausible (between 1900 and today, max 120 years ago), expiry is after DOB |
| **3. Back-page integrity** | File number matches `[A-Z]{2,3}[0-9]{8,15}` format, PIN is 6-digit, address has sufficient structure |
| **4. Document consistency** | Visual passport number matches MRZ-encoded number; file number RPO matches address RPO |
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

> **Note:** `viz_mrz_crosscheck_valid` appears in `integrity_flags` as a convenience field derived from `mrz_visual_dob_match` but is **not scored independently** — it was removed from the scoring table to prevent double-counting the same DOB mismatch.

| Tier | Condition |
|---|---|
| `PASSED` / `HIGH` | Score ≥ 85 and no critical failures |
| `REVIEW_REQUIRED` / `MEDIUM` or `LOW` | Score 60–84, or any medium failure without critical, or visual DOB missing |
| `FAILED` / `REJECT` | Any critical failure or score < 60 |

## Optional LLM Fallback

When `GROQ_API_KEY` is set, the worker runs the deterministic engine first and only calls the LLM when:

- The OCR raw text from at least one page is available, **and**
- The first-pass result is `FAILED`, **or** passport number / DOB / expiry are missing

The LLM receives the raw OCR text from both pages and is asked to return structured JSON. That output is normalised into the same OCR shape and fed back through `runValidation()`. The better result (by score, then by status rank) is used. The full trace — first pass, LLM action, second pass — is included in the response.

Set `GROQ_FALLBACK_DISABLED=true` to disable the fallback without removing the API key.

## Security

### API Key Authentication

Set `API_KEY` in your environment to require all clients to send `X-API-Key: <value>`. Requests without the correct key receive `401 Unauthorized`. Leave `API_KEY` unset to disable (default).

### Rate Limiting

An in-memory sliding-window rate limiter is applied per client IP. Defaults are 60 requests per 60-second window. Override with `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`.

> **Note:** The rate limiter is single-process in-memory. If you run multiple API replicas behind a load balancer, replace it with a Redis-backed implementation.

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

Current coverage (24 tests, all passing):

- MRZ checksum and composite check digit computation
- MRZ line 1 and line 2 parsing and integrity checks
- Visual DOB vs MRZ DOB matching (multiple date formats)
- Temporal integrity (expiry, DOB plausibility)
- Back-page integrity (file number, PIN, address)
- Document consistency (visual vs MRZ passport number, RPO alignment)
- Integrity scoring (PASSED / REVIEW_REQUIRED / FAILED tiers)
- LLM fallback normalization, MRZ line selection, and fallback trace builder
- Google Vision OCR normalization and MRZ extraction

## Logging

The service emits structured JSON to stdout (info/warn/debug) and stderr (error). Each line is a JSON object:

```json
{"time":"2026-06-26T08:00:00.000Z","level":"info","msg":"Job completed","job_id":"job_01ABC...","verification_status":"PASSED","integrity_score":92,"llm_used":false}
```

Set `LOG_LEVEL=debug` to see all log lines including per-field details.
