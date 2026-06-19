# Passport Validator Project Context

## Purpose
This project is a Node.js/Express API for passport OCR extraction and validation. It accepts passport front and back images, uses Google Cloud Vision OCR to extract text, normalizes passport fields, validates the extracted data, and returns a structured JSON response.

## Runtime flow
1. `src/server.js`
   - Loads `dotenv` configuration.
   - Requires `GOOGLE_APPLICATION_CREDENTIALS` environment variable.
   - Starts the Express app on `PORT` or `3000`.

2. `src/api/app.js`
   - Creates an Express application.
   - Mounts routes at `/api/v1/jobs`.
   - Provides `GET /healthz` for health checks.
   - Sends JSON error responses on failure.

3. `src/api/routes/jobs.js`
   - Handles `POST /api/v1/jobs/verify-passport`.
   - Accepts multipart form uploads with `front_image` and `back_image`.
   - Uses `multer` memory storage and allows only `image/jpeg` and `image/png`.
   - Calls OCR extraction and validation services.
   - Returns:
     - `job_id`
     - `processing_metrics`
     - `verification_status`
     - `integrity_flags`
     - `extracted_data`
     - `extracted_features`
     - `google_ocr_raw`

## OCR extraction
- `src/providers/googleVisionClient.js`
  - Uses `@google-cloud/vision` `ImageAnnotatorClient`.
  - Calls `documentTextDetection` for both front and back images.
  - Extracts `fullTextAnnotation.text`.
  - Normalizes passport fields from OCR text:
    - MRZ line 2
    - passport number
    - date of birth
    - expiry date
    - file number
    - address block
  - Exposes raw OCR text as `raw.google_vision.front` and `raw.google_vision.back`.

- `src/providers/ocrClient.js`
  - Thin wrapper around Google Vision extraction.

## Validation logic
- `src/services/validationEngine.js`
  - Builds normalized extracted data from OCR output.
  - Chooses MRZ-derived values where applicable.
  - Produces validation status and integrity flags.

## Validators
- `src/validators/mrzChecksum.js`
  - Parses MRZ line 2 and validates checksums.
- `src/validators/rpoMapping.js`
  - Provides field mapping and recognition helpers.
- `src/validators/visualCrosscheck.js`
  - Cross-checks visual OCR values against MRZ/extracted fields.

## Tests
- `test/googleVisionClient.test.js`
- `test/validationEngine.test.js`
- `test/validators.test.js`

## Package and scripts
- `package.json`
  - `type: module`
  - Dependencies:
    - `@google-cloud/vision`
    - `dotenv`
    - `express`
    - `multer`
    - `ulid`
  - Dev dependency: `nodemon`
  - Script: `npm run dev:api` runs `nodemon src/server.js`

## Current response behavior
- The API returns only the raw extracted OCR text in `google_ocr_raw`.
- It does not expose full Google Vision annotation metadata such as vertices.
