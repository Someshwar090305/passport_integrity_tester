# Asynchronous Passport Validation Engine

Node.js microservice that accepts passport images, runs OCR through Sarvam Doc Digitization, performs internal integrity checks, and posts signed webhook results asynchronously.

## What This Service Does

- Accepts `front_image` and `back_image` via `POST /api/v1/jobs/verify-passport`
- Pushes the job into a Redis-backed BullMQ queue
- Worker zips both images and executes Sarvam's multi-step job flow:
  - create job
  - request presigned upload URL
  - upload ZIP to storage URL
  - start job
  - poll status
  - request download URLs and parse output ZIP contents
- Runs internal checks:
  - MRZ checksum validation
  - visual DOB vs MRZ DOB cross-check
  - RPO code vs address mapping
- Sends final payload to client `callback_url` with HMAC signature (`X-Signature`)

## Tech Stack

- Node.js (ESM)
- Express 5
- BullMQ + Redis
- Axios
- Multer (memory upload, MIME/size checks)
- JSZip
- Node built-in test runner (`node --test`)

## Project Structure

```text
src/
  api/
    app.js
    routes/jobs.js
  providers/
    sarvamClient.js
  queue/
    connection.js
    constants.js
    passportQueue.js
  services/
    validationEngine.js
  validators/
    mrzChecksum.js
    visualCrosscheck.js
    rpoMapping.js
  webhook/
    dispatcher.js
  worker/
    passportWorker.js
  server.js
test/
  validators.test.js
  validationEngine.test.js
```

## Prerequisites

- Node.js 18+ (recommended: latest LTS)
- Redis running locally (default: `redis://127.0.0.1:6379`)
- Sarvam API key and working Doc Digitization endpoints

## Installation

```bash
npm install
```

## Environment Variables

Create `.env` in the project root (copy from `.env.example`):

```env
PORT=3000
REDIS_URL=redis://127.0.0.1:6379
WORKER_CONCURRENCY=4
WEBHOOK_SECRET=replace-with-shared-secret

SARVAM_API_URL=https://api.sarvam.ai/doc-digitization/job/v1/upload-files
SARVAM_CREATE_JOB_URL=https://api.sarvam.ai/doc-digitization/job/v1
SARVAM_JOB_PARAMETERS_JSON={}
SARVAM_START_JOB_URL_TEMPLATE=https://api.sarvam.ai/doc-digitization/job/v1/{job_id}/start
SARVAM_STATUS_URL_TEMPLATE=https://api.sarvam.ai/doc-digitization/job/v1/{job_id}/status
SARVAM_DOWNLOAD_URL_TEMPLATE=https://api.sarvam.ai/doc-digitization/job/v1/{job_id}/download-files
SARVAM_RESULT_POLL_ATTEMPTS=12
SARVAM_RESULT_POLL_INTERVAL_MS=1500
SARVAM_API_KEY=replace-with-sarvam-key
```

### Required at Startup

API and worker both fail fast if these are missing:

- `SARVAM_API_URL`
- `SARVAM_API_KEY`
- `SARVAM_CREATE_JOB_URL`
- `SARVAM_START_JOB_URL_TEMPLATE`
- `SARVAM_STATUS_URL_TEMPLATE`
- `SARVAM_DOWNLOAD_URL_TEMPLATE`
- `WEBHOOK_SECRET`
- `REDIS_URL`

## Running the Service

Run these in separate terminals:

```bash
npm run dev:api
```

```bash
npm run dev:worker
```

Health check:

```bash
curl http://localhost:3000/healthz
```

Expected:

```json
{"status":"ok"}
```

## API

### `POST /api/v1/jobs/verify-passport`

Accepts multipart form data:

- `front_image` (required, `image/jpeg` or `image/png`, max 8MB)
- `back_image` (required, `image/jpeg` or `image/png`, max 8MB)
- `callback_url` (required, public `http/https` URL)

#### Example Request

```bash
curl -X POST http://localhost:3000/api/v1/jobs/verify-passport \
  -F "front_image=@./samples/front.jpg" \
  -F "back_image=@./samples/back.jpg" \
  -F "callback_url=https://your-public-webhook.example.com/callback"
```

#### Example 202 Response

```json
{
  "status": "processing",
  "job_id": "job_01ABCDEF...",
  "message": "Images buffered and queued. Results will be posted to the callback URL."
}
```

### `POST /api/v1/jobs/verify-passport-sync`

Same image inputs, but instead of requiring a `callback_url`, this endpoint returns the final verification payload directly in the HTTP response (useful for testing via Postman).

Accepts multipart form data:

- `front_image` (required, `image/jpeg` or `image/png`, max 8MB)
- `back_image` (required, `image/jpeg` or `image/png`, max 8MB)

#### Example 200 Response

Returns the same JSON payload shape that the worker would normally POST to `callback_url`:

- `job_id`
- `processing_metrics`
- `verification_status`
- `integrity_flags`
- `extracted_data`
- `extracted_features`

Note: this endpoint waits for Sarvam OCR + validation to complete, so the request may take longer than the async `202` endpoint.

## Webhook Contract

Worker sends JSON payload to the provided `callback_url`:

- `job_id`
- `processing_metrics`
  - `queue_wait_ms`
  - `sdk_extraction_ms`
  - `internal_validation_ms`
- `verification_status` (`PASSED` or `FAILED`)
- `integrity_flags`
  - `mrz_checksums_valid`
  - `viz_mrz_crosscheck_valid`
  - `rpo_address_mapping_valid`
- `extracted_data`
- `extracted_features` (detailed debugging/verification fields)

Header:

- `X-Signature: sha256=<hmac_hex>`

Signature is `HMAC-SHA256(secret=WEBHOOK_SECRET, body=raw_json_string)`.

## Validation Logic

### 1) MRZ Checksum

- Parses MRZ line 2 and validates passport number, DOB, and expiry checksum segments.

### 2) Visual vs MRZ DOB Cross-check

- Normalizes OCR DOB formats (ISO, DD/MM/YYYY, YYMMDD) and compares with MRZ DOB.

### 3) RPO Mapping

- Extracts RPO from file number (with alias handling like `MA -> MAA`).
- Parses address block for city/state/PIN.
- Verifies inferred region consistency against internal RPO region map.

## Sarvam Integration Flow (Implemented)

For each queued job:

1. Create Sarvam job (`SARVAM_CREATE_JOB_URL`)
2. Request upload URL (`SARVAM_API_URL`) for one ZIP file
3. Upload ZIP binary to returned `file_url` (presigned URL)
4. Start job (`SARVAM_START_JOB_URL_TEMPLATE`)
5. Poll status (`SARVAM_STATUS_URL_TEMPLATE`)
6. Download file links (`SARVAM_DOWNLOAD_URL_TEMPLATE`)
7. Fetch result ZIP and parse text-like files (`.html`, `.json`, etc.)
8. Normalize extracted fields for downstream validation

Notes:

- This implementation uploads **one ZIP containing front + back images** because Sarvam upload flow expects one file per job.

## Security Notes

- Callback URL has SSRF guard:
  - blocks localhost, loopback, private RFC1918 ranges, link-local, and IPv6 local ranges.
- Webhook payload is HMAC-signed.
- Do not commit `.env` or secrets.

## Tests

Run:

```bash
npm test
```

Covers:

- MRZ checksum validator
- visual/MRZ DOB match
- RPO extraction + mapping
- Sarvam response normalization
- Validation engine output structure

## Common Troubleshooting

### 400: `callback_url must be ... public host`

Cause: local callback (`localhost`, `127.0.0.1`, private IP) blocked by SSRF guard.

Fix:

- Use a public HTTPS endpoint (for example via tunneling/proxy).

### Worker fails with missing env vars

Cause: one of required variables is empty/missing.

Fix:

- Verify `.env` values exactly.
- Restart API and worker after changes.

### Sarvam returns `Only one file ... allowed`

Cause: sending two separate files to upload endpoint.

Fix:

- Keep current ZIP bundling approach (already implemented).

### Sarvam job completes but fields are null

Cause: extracted output may be inside downloaded ZIP files, not directly in top-level JSON.

Fix:

- Ensure download step and ZIP extraction are enabled (already in `sarvamClient.js`).

### API usage appears zero in dashboard

- Confirm requests are going to `api.sarvam.ai` endpoints, not docs/website URLs.
- Check worker logs for create/start/status/download calls and failures.
- Confirm valid `SARVAM_API_KEY` is loaded in the running worker process.

## Development Notes

- Queue name: `passport-verification`
- Retry policy: 3 attempts with exponential backoff
- Completed and failed jobs are retained with capped counts (`removeOnComplete`, `removeOnFail`)

## License

ISC (as currently declared in `package.json`).

