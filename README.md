# Passport Validator

Node.js microservice that accepts passport images, runs OCR through Google Cloud Vision, performs internal integrity checks, and returns validation results synchronously.

## What This Service Does

- Accepts `front_image` and `back_image` via `POST /api/v1/jobs/verify-passport`
- Runs OCR using Google Cloud Vision
- Parses MRZ, passport number, date of birth, expiry, file number, and address
- Validates MRZ checksums, visual vs MRZ DOB, and RPO/address mapping
- Returns the verification payload directly in the HTTP response

## Tech Stack

- Node.js (ESM)
- Express
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
  services/
    validationEngine.js
  validators/
    mrzChecksum.js
    visualCrosscheck.js
    rpoMapping.js
  server.js
test/
  validators.test.js
  validationEngine.test.js
```

## Prerequisites

- Node.js 18+ (recommended: latest LTS)
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
GOOGLE_APPLICATION_CREDENTIALS=C:\Boharr\passport_validator\credentials\passport-validation-498409-650796f02eeb.json
```

## Running the Service

```bash
npm run dev:api
```

Health check:

```bash
curl http://localhost:3000/healthz
```

Expected response:

```json
{"status":"ok"}
```

## API

### `POST /api/v1/jobs/verify-passport`

Accepts multipart form data:

- `front_image` (required, `image/jpeg` or `image/png`, max 8MB)
- `back_image` (required, `image/jpeg` or `image/png`, max 8MB)

#### Example request

```bash
curl -X POST http://localhost:3000/api/v1/jobs/verify-passport \
  -F "front_image=@./samples/front.jpg" \
  -F "back_image=@./samples/back.jpg"
```

#### Example response

```json
{
  "job_id": "job_01ABCDEF...",
  "processing_metrics": {
    "queue_wait_ms": 0,
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
