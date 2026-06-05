import { extractPassportData as extractPassportDataFromGoogleVision } from './googleVisionClient.js';

export async function extractPassportData(frontImageEncoded, backImageEncoded) {
  return extractPassportDataFromGoogleVision(frontImageEncoded, backImageEncoded);
}
