import vision from '@google-cloud/vision';
import fs from 'fs';
const client = new vision.ImageAnnotatorClient({
  keyFilename:
    './credentials/passport-validation-498409-650796f02eeb.json'
});

const image = fs.readFileSync('./sample-passport.jpg');

const [result] = await client.documentTextDetection({
  image: {
    content: image.toString('base64')
  }
});

console.log(result.fullTextAnnotation?.text);