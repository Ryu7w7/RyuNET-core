/**
 * sdvx_jacket_resolver.ts
 *
 * Resolves SDVX jacket URLs with two strategies:
 *
 * 1. DISK MODE (preferred): If SDVX_MUSIC_ROOT env var is set, scans the
 *    actual music directory to find the real folder name for a given mid,
 *    just like bot.js does. This gives 100% accurate folder names.
 *
 * 2. STATIC MAP MODE (fallback): Uses the pre-built sdvxJackets map from
 *    sdvx_jackets.ts. This can be stale or missing newer songs.
 *
 * Usage:
 *   Set SDVX_MUSIC_ROOT in your environment to the SDVX music folder, e.g.:
 *     SDVX_MUSIC_ROOT=/mnt/extra/bhub/SDVX/data/music
 *   Optionally also set SDVX_CUSTOM_MUSIC_ROOT for custom song overrides.
 */

import fs from 'fs';
import path from 'path';
import { sdvxJackets } from './sdvx_jackets';

const JACKETS_BASE_URL = 'https://jackets.ryu7w7.xyz/sdvx';
export const DUMMY_JACKET_URL = `${JACKETS_BASE_URL}/jk_dummy.png`;

const MUSIC_ROOT = process.env.SDVX_MUSIC_ROOT || '';
const CUSTOM_MUSIC_ROOT = process.env.SDVX_CUSTOM_MUSIC_ROOT || '';

if (MUSIC_ROOT) {
  console.log(`[SdvxJackets] Disk mode active: scanning ${MUSIC_ROOT}`);
} else {
  console.log(`[SdvxJackets] Static map mode (set SDVX_MUSIC_ROOT for precise jacket matching)`);
}

// Cache: mid (number) -> actual folder name found on disk
const folderCache = new Map<number, string | null>();

/**
 * Scan the music roots to find the folder for a given mid.
 * e.g. mid=1 -> "0001_albida_muryoku"
 * Returns null if not found.
 */
function findFolderOnDisk(mid: number): string | null {
  if (folderCache.has(mid)) return folderCache.get(mid)!;

  const mid4 = String(mid).padStart(4, '0');
  const prefix = `${mid4}_`;
  const roots = [CUSTOM_MUSIC_ROOT, MUSIC_ROOT].filter(Boolean);

  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith(prefix)) {
          folderCache.set(mid, e.name);
          return e.name;
        }
      }
    } catch (e) {
      // Root not accessible
    }
  }

  folderCache.set(mid, null);
  return null;
}

/**
 * Find folder name for a mid, using disk (if SDVX_MUSIC_ROOT is set)
 * or falling back to the static sdvxJackets map.
 */
function resolveFolderName(mid: number | string): string | null {
  const midNum = Number(mid);
  const midStr = String(mid);
  const mid4 = String(mid).padStart(4, '0');

  if (MUSIC_ROOT) {
    return findFolderOnDisk(midNum);
  }

  // Static map fallback
  return sdvxJackets[midStr] || null;
}

/**
 * Check if a specific jacket file exists on disk.
 * Only used in disk mode to pick the best available variant.
 */
function jacketFileExists(folder: string, mid4: string, variant: number): boolean {
  const roots = [CUSTOM_MUSIC_ROOT, MUSIC_ROOT].filter(Boolean);
  const fname = `jk_${mid4}_${variant}.png`;
  for (const root of roots) {
    if (fs.existsSync(path.join(root, folder, fname))) return true;
  }
  return false;
}

/**
 * Build the jacket URL for a given mid and difficulty type.
 *
 * In DISK MODE: finds the real folder on disk, checks which variant
 *   files exist (4->3->2->1), returns the best accurate URL.
 *
 * In STATIC MAP MODE: returns the URL using the static map folder name,
 *   starting at the preferred variant. Client-side jacketFallback() in the
 *   pug template handles 404s by trying lower variants.
 */
export function sdvxJacketUrl(mid: number | string, type: number | string): string {
  const mid4 = String(mid).padStart(4, '0');
  const preferred = Math.min(Number(type) + 1, 4);

  const folder = resolveFolderName(mid);

  if (!folder) {
    // Mid not found anywhere — return dummy
    return DUMMY_JACKET_URL;
  }

  if (MUSIC_ROOT) {
    // Disk mode: verify which variant actually exists
    const candidates = [preferred, 4, 3, 2, 1];
    for (const variant of candidates) {
      if (jacketFileExists(folder, mid4, variant)) {
        return `${JACKETS_BASE_URL}/${folder}/jk_${mid4}_${variant}.png`;
      }
    }
    // No variants found — return dummy
    return DUMMY_JACKET_URL;
  }

  // Static map mode: return preferred variant URL; client-side fallback handles 404s
  return `${JACKETS_BASE_URL}/${folder}/jk_${mid4}_${preferred}.png`;
}

/**
 * Pre-warm the folder cache for a list of mids.
 * Call this at startup or before rendering profiles if SDVX_MUSIC_ROOT is set,
 * to avoid per-request directory scans.
 */
export function prewarmJacketCache(mids: (number | string)[]): void {
  if (!MUSIC_ROOT) return;
  for (const mid of mids) {
    findFolderOnDisk(Number(mid));
  }
}
