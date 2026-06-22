import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const DEFAULT_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);
const DEFAULT_TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 600000);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

function parseArgs(argv) {
  const args = { baseUrl: DEFAULT_BASE_URL, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, timeoutMs: DEFAULT_TIMEOUT_MS };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url' || arg === '-u') {
      args.baseUrl = argv[i + 1];
      i += 1;
    } else if (arg === '--poll-interval-ms') {
      args.pollIntervalMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }

  return args;
}

function isImageFile(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickImageCandidates(imageFiles) {
  const exactFront = imageFiles.find((file) =>
    /^(front|front_image|front-image)\.(jpg|jpeg|png)$/i.test(file.name)
  );
  const exactBack = imageFiles.find((file) =>
    /^(back|back_image|back-image)\.(jpg|jpeg|png)$/i.test(file.name)
  );

  if (exactFront && exactBack) {
    return { front: exactFront, back: exactBack };
  }

  const front = imageFiles.find((file) =>
    /front|page 1|page1|left|cover|scan 1|scan1/i.test(file.name)
  );
  const back = imageFiles.find((file) =>
    /back|page 2|page2|right|backside|scan 2|scan2/i.test(file.name)
  );

  if (front && back) {
    return { front, back };
  }

  if (imageFiles.length >= 2) {
    return {
      front: imageFiles[0],
      back: imageFiles[1]
    };
  }

  return null;
}

async function getSampleFolders(samplesDir) {
  const entries = await fs.readdir(samplesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(samplesDir, entry.name));
}

async function readFolderImages(folderPath) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && isImageFile(entry.name));
}

async function postVerificationJob(baseUrl, folderPath, frontFile, backFile) {
  const formData = new FormData();
  const frontBuffer = await fs.readFile(path.join(folderPath, frontFile.name));
  const backBuffer = await fs.readFile(path.join(folderPath, backFile.name));

  formData.append(
    'front_image',
    new Blob([frontBuffer], { type: 'image/jpeg' }),
    frontFile.name
  );
  formData.append(
    'back_image',
    new Blob([backBuffer], { type: 'image/jpeg' }),
    backFile.name
  );

  const response = await fetch(`${baseUrl}/api/v1/jobs/verify-passport`, {
    method: 'POST',
    body: formData
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      `Request failed for ${path.basename(folderPath)}: ${response.status} ${JSON.stringify(payload)}`
    );
  }

  return payload;
}

async function pollJob(baseUrl, jobId, pollIntervalMs, timeoutMs) {
  const startedAt = Date.now();

  while (true) {
    const response = await fetch(`${baseUrl}/api/v1/jobs/${jobId}`);
    const payload = await response.json();

    if (response.status === 200) {
      return payload;
    }

    if (response.status === 202) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for job ${jobId}`);
      }
      await delay(pollIntervalMs);
      continue;
    }

    throw new Error(
      `Unexpected polling response for job ${jobId}: ${response.status} ${JSON.stringify(payload)}`
    );
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Usage: npm run samples:run -- --base-url http://localhost:3000\n`);
    return;
  }

  if (!args.baseUrl) {
    throw new Error('Please provide a base URL with --base-url or API_BASE_URL');
  }

  const samplesDir = path.join(projectRoot, 'samples');
  const sampleFolders = await getSampleFolders(samplesDir);

  if (sampleFolders.length === 0) {
    console.log(`No sample folders found under ${samplesDir}`);
    return;
  }

  console.log(`Running ${sampleFolders.length} sample case(s) against ${args.baseUrl}`);

  for (const folderPath of sampleFolders) {
    const folderName = path.basename(folderPath);
    const imageFiles = await readFolderImages(folderPath);

    if (imageFiles.length < 2) {
      console.warn(`Skipping ${folderName}: found ${imageFiles.length} image file(s)`);
      continue;
    }

    const selected = pickImageCandidates(imageFiles);

    if (!selected) {
      console.warn(`Skipping ${folderName}: unable to determine front/back images`);
      continue;
    }

    const { front, back } = selected;
    console.log(`\n[${folderName}] Uploading ${front.name} + ${back.name}`);

    try {
      const initialResponse = await postVerificationJob(
        args.baseUrl,
        folderPath,
        front,
        back
      );
      console.log(`Job accepted: ${initialResponse.job_id}`);

      const result = await pollJob(
        args.baseUrl,
        initialResponse.job_id,
        args.pollIntervalMs,
        args.timeoutMs
      );

      console.log(JSON.stringify({
        case: folderName,
        job_id: initialResponse.job_id,
        status: result.status || result.verification_status || 'completed',
        extracted: result.extracted_data || null,
        verification: result.verification_status || null,
        integrity_flags: result.integrity_flags || null
      }, null, 2));
    } catch (error) {
      console.error(`Failed for ${folderName}: ${error.message}`);
    }
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
