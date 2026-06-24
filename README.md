# Passport Validator

A Node.js service for validating passport images by combining OCR, deterministic validation rules, and an optional LLM-based fallback. The API accepts front/back passport images, queues verification jobs, and returns structured results asynchronously through a Redis-backed job queue.

## Current Status

The service now supports:

- OCR-based passport extraction using Google Cloud Vision
- Deterministic validation for MRZ checksums, visual vs MRZ DOB matching, and RPO/address mapping
- An optional Groq-backed LLM fallback that runs when the first-pass validation looks weak or incomplete
- Structured normalization of LLM output into the same shape used by the existing validation engine
- Batch execution of sample passport cases through a sample-runner script
- Rich job responses that include a fallback trace showing the first-pass result, the LLM action, and the second-pass validation result

## What the Service Does

- Accepts `front_image` and `back_image` via `POST /api/v1/jobs/verify-passport`
- Queues the request for asynchronous processing using BullMQ
- Runs OCR in a background worker
- Extracts passport number, DOB, expiry date, file number, address, and MRZ details
- Validates MRZ checksums, visual vs MRZ DOB, and RPO/address mapping
- Optionally uses an LLM fallback when the deterministic engine needs help with noisy or incomplete OCR data
- Returns a `202 Accepted` response immediately with a `job_id` for polling

## Tech Stack

- Node.js (ESM)
- Express
- BullMQ + Redis
- Google Cloud Vision
- Multer
- dotenv

## Project Structure

```text
src/
  api/
    app.js
    routes/jobs.js
  providers/
    googleVisionClient.js
    ocrClient.js
  queue/
    passportQueue.js
  services/
    validationEngine.js
    llmFallback.js
  validators/
    mrzChecksum.js
    visualCrosscheck.js
    rpoMapping.js
  worker/
    passportWorker.js
  server.js
scripts/
  run-sample-cases.js
test/
  googleVisionClient.test.js
  validationEngine.test.js
  validators.test.js
  llmFallback.test.js
```

## Prerequisites

- Node.js 18+
- Redis server running locally or remotely
- Google service account JSON credentials
- `GOOGLE_APPLICATION_CREDENTIALS` pointing to the credentials file

## Installation

```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root. A sample is also available in [.env.example](.env.example).

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
GOOGLE_APPLICATION_CREDENTIALS=./credentials/passport-validation-498409-650796f02eeb.json

# Optional: enable Groq-based LLM fallback
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
```

## Running the Service

You need the API, the worker, and Redis running.

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

This endpoint is asynchronous. It accepts multipart form data, creates a background job, and returns immediately with a job identifier.

Request fields:

- `front_image` (required, `image/jpeg` or `image/png`, max 8MB)
- `back_image` (required, `image/jpeg` or `image/png`, max 8MB)

#### Example request

```bash
curl -X POST http://localhost:3000/api/v1/jobs/verify-passport \
  -F "front_image=@./samples/Demo passport 1/front.jpg" \
  -F "back_image=@./samples/Demo passport 1/back.jpg"
```

### `GET /api/v1/jobs/:jobId`

Poll this endpoint until the job is complete.

- `202 Accepted` if the job is still running or queued
- `200 OK` when the verification result is ready
- `500` if the job fails during processing

#### Example completed response

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
    "viz_mrz_crosscheck_valid": true,
    "rpo_address_mapping_valid": true
  },
  "extracted_data": {
    "passport_number": "A1234567",
    "date_of_birth": "1990-01-01",
    "expiry_date": "2030-01-01",
    "rpo_code": "XYZ",
    "parsed_address": {
      "pin_code": "123456",
      "city": "SomeCity"
    }
  },
  "extracted_features": {
    "mrz": {
      "line2": "...",
      "passport_number": "A1234567",
      "date_of_birth_raw": "900101",
      "expiry_date_raw": "300101",
      "checksum_details": {}
    },
    "visual": {
      "date_of_birth_raw": "1990-01-01"
    },
    "back_page": {
      "file_number_raw": "XYZ123456",
      "address_block_raw": "...",
      "parsed_address": {
        "pin_code": "123456",
        "city": "SomeCity"
      }
    },
    "inferred": {
      "rpo_code": "XYZ"
    },
    "llm_fallback": {
      "used": true,
      "model": "llama-3.3-70b-versatile"
    }
  },
  "fallback_trace": {
    "triggered": true,
    "reason": "initial validation was weak",
    "first_pass": {
      "verification_status": "FAILED",
      "integrity_flags": {
        "mrz_checksums_valid": false,
        "viz_mrz_crosscheck_valid": false,
        "rpo_address_mapping_valid": true
      }
    },
    "llm_action": {
      "status": "success",
      "model": "llama-3.3-70b-versatile",
      "fields_updated": {
        "passport_number": {
          "before": "OLD123",
          "after": "NEW123",
          "changed": true
        }
      }
    },
    "second_pass": {
      "verification_status": "PASSED",
      "integrity_flags": {
        "mrz_checksums_valid": true,
        "viz_mrz_crosscheck_valid": true,
        "rpo_address_mapping_valid": true
      }
    }
  }
}
```

## Batch Sample Runner

You can run every sample folder automatically without uploading them one by one in Postman.

For the most reliable results, place each image pair in a sample directory using either:

- `front.jpg` / `back.jpg`
- `front.png` / `back.png`

If the files are already named that way, the script will use them directly.

```bash
npm run samples:run -- --base-url http://localhost:3000
```

Optional flags:

- `--poll-interval-ms 2000` to control how often the script checks job status
- `--timeout-ms 600000` to stop waiting after 10 minutes per case

## Optional LLM Fallback

If `GROQ_API_KEY` is set, the worker will use the deterministic engine first and only call the LLM fallback when the engine output looks weak or incomplete. The LLM output is normalized into the same shape expected by the validator so it can be re-run through the same validation pipeline.

## Manual Testing Flow

1. Start Redis.
2. Start the API with `npm run dev:api`.
3. Start the worker with `npm run dev:worker`.
4. Send a multipart request to `POST /api/v1/jobs/verify-passport`.
5. Copy the returned `job_id`.
6. Poll `GET /api/v1/jobs/<job_id>` until you receive a `200` response.

## Tests

Run:

```bash
npm test
```

Current coverage includes:

- MRZ checksum validation
- visual vs MRZ DOB matching
- RPO extraction and mapping
- engine output structure
- LLM fallback normalization and trace generation
