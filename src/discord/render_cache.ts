import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SAVE_PATH } from '../utils/EamuseIO';

// Disk cache for rendered Discord images (recent score / B50). Keyed by a
// data-version string (refid + profile name + score count + max updatedAt),
// so a cached image is only served while the player's data hasn't changed.
const CACHE_DIR = path.join(SAVE_PATH, 'discord_cache');
const MAX_CACHE_FILES = 500;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch (e) {
  // Non-fatal: cache just won't persist.
}

function fileFor(key: string): string {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(CACHE_DIR, `${hash}.png`);
}

export function getCachedRender(key: string): Buffer | null {
  try {
    const file = fileFor(key);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file);
  } catch (e) {
    return null;
  }
}

let lastCleanup = 0;

function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  try {
    const entries = fs
      .readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ f, t: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }));

    if (entries.length > MAX_CACHE_FILES) {
      entries.sort((a, b) => a.t - b.t);
      for (const e of entries.slice(0, entries.length - MAX_CACHE_FILES)) {
        try {
          fs.unlinkSync(path.join(CACHE_DIR, e.f));
        } catch (err) {
          // ignore
        }
      }
    }
  } catch (e) {
    // ignore
  }
}

export function putCachedRender(key: string, buffer: Buffer): void {
  try {
    fs.writeFileSync(fileFor(key), buffer);
    maybeCleanup();
  } catch (e) {
    // Non-fatal: render still works, it just won't be cached.
  }
}
