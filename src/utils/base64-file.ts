import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { formatDate } from './timezone';

const BASE64_FILE_DIR = path.join(os.homedir(), '.models-manager', 'base64-files');
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let cleanupScheduled = false;

function ensureDirExists(): void {
  if (!fs.existsSync(BASE64_FILE_DIR)) {
    fs.mkdirSync(BASE64_FILE_DIR, { recursive: true });
  }
}

export function getBase64FileDir(): string {
  ensureDirExists();
  scheduleCleanup();
  return BASE64_FILE_DIR;
}

export interface Base64FileResult {
  base64FileName: string;
  imageFileName?: string;
  imageUrl?: string;
  base64Url?: string;
}

export async function createBase64File(dataUri: string): Promise<Base64FileResult> {
  ensureDirExists();
  const hash = crypto.createHash('sha256').update(dataUri).digest('hex').slice(0, 16);
  const base64FileName = `${hash}.base64`;
  const base64FilePath = path.join(BASE64_FILE_DIR, base64FileName);

  try {
    await fs.promises.access(base64FilePath);
  } catch {
    await fs.promises.writeFile(base64FilePath, dataUri, 'utf8');
  }

  let imageFileName: string | undefined;
  let imageUrl: string | undefined;

  try {
    const match = dataUri.match(/^data:(image\/\w+);base64,(.+)$/i);
    if (!match) throw new Error('not-image-data-uri');

    const [, mimeType, encoded] = match;
    const extension = mimeType.split('/')[1] || 'bin';
    const imageBuffer = Buffer.from(encoded, 'base64');
    imageFileName = `${hash}.${extension}`;
    const imageFilePath = path.join(BASE64_FILE_DIR, imageFileName);
    await fs.promises.writeFile(imageFilePath, imageBuffer);
    imageUrl = imageFileName;
  } catch {
    // ignore image conversion failure, base64 file will still be used
  }

  cleanupOldFiles().catch(() => {});
  return {
    base64FileName,
    imageFileName,
    imageUrl,
    base64Url: base64FileName,
  };
}

async function cleanupOldFiles(): Promise<void> {
  ensureDirExists();
  try {
    const files = await fs.promises.readdir(BASE64_FILE_DIR);
    const today = formatDate(new Date());
    await Promise.all(
      files.map(async (file) => {
        if (!file.endsWith('.base64')) return;
        const filePath = path.join(BASE64_FILE_DIR, file);
        const stat = await fs.promises.stat(filePath);
        const fileDate = formatDate(stat.mtime);
        if (fileDate !== today) {
          await fs.promises.unlink(filePath).catch(() => {});
        }
      }),
    );
  } catch {
    // ignore cleanup errors
  }
}

function scheduleCleanup(): void {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  cleanupOldFiles().catch(() => {});
  setInterval(() => cleanupOldFiles().catch(() => {}), CLEANUP_INTERVAL_MS);
}
