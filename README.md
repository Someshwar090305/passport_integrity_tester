# Passport Validator

Node.js microservice that accepts passport images, runs OCR through Google Cloud Vision, performs integrity checks, and returns results asynchronously through a Redis-backed job queue.

## What This Service Does

- Accepts `front_image` and `back_image` via `POST /api/v1/jobs/verify-passport`
- Queues the request for asynchronous processing using BullMQ
- Runs OCR using Google Cloud Vision in a background worker
- Parses MRZ, passport number, date of birth, expiry, file number, and address
- Validates MRZ checksums, visual vs MRZ DOB, and RPO/address mapping
- Returns `202 Accepted` immediately with a `job_id` for polling

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
  validators/
    mrzChecksum.js
    visualCrosscheck.js
    rpoMapping.js
  worker/
    passportWorker.js
  server.js
test/
  validators.test.js
  validationEngine.test.js
```

## Prerequisites

- Node.js 18+ (recommended: latest LTS)
- Redis server running locally or remotely
- Google service account JSON credentials
- `GOOGLE_APPLICATION_CREDENTIALS` pointing to the credentials file

## Installation

```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root with:

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
GOOGLE_APPLICATION_CREDENTIALS=.\credentials\passport-validation-498409-650796f02eeb.json
```

## Running the Service

You need both the API and the worker running, plus Redis.

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

If your sample image names differ, replace the paths with the actual files you want to test.

#### Example accepted response

```json
{
  "job_id": "job_01ABCDEF...",
  "status": "queued",
  "message": "Verification job accepted for background processing"
}
```

### `GET /api/v1/jobs/:jobId`

Poll this endpoint until the job is complete.

- `202 Accepted` if the job is still running or queued
- `200 OK` when the verification result is ready
- `500` if the job fails during processing

Use the exact `job_id` returned from the POST response. Do not include braces or extra spaces in the URL.

#### Example polling response while processing

```json
{
  "job_id": "job_01ABCDEF...",
  "status": "running",
  "message": "Job is still processing"
}
```

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
    }
  }
}
```

## Manual Testing Flow

1. Start Redis.
2. Start the API with `npm run dev:api`.
3. Start the worker with `npm run dev:worker`.
4. Send a multipart request to `POST /api/v1/jobs/verify-passport`.
5. Copy the returned `job_id`.
6. Poll `GET /api/v1/jobs/<job_id>` until you receive a `200` response.

Example polling command:

```bash
curl http://localhost:3000/api/v1/jobs/job_01ABCDEF...
```

## Tests

Run:

```bash
npm test
```

Covers:

- MRZ checksum validation
- visual/MRZ DOB matching
- RPO extraction and mapping
- validation engine output structure
