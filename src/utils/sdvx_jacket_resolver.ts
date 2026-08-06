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
import { promises as fsp } from 'fs';
import path from 'path';
import { sdvxJackets } from './sdvx_jackets';
import { CONFIG } from './ArgConfig';

const JACKETS_BASE_URL = 'https://jackets.ryu7w7.xyz/sdvx';
export const DUMMY_JACKET_URL = `${JACKETS_BASE_URL}/jk_dummy.png`;

// Note: dynamic getters so it respects changes at runtime without restart
const getMusicRoot = () => CONFIG.sdvx_music_root || process.env.SDVX_MUSIC_ROOT || '';
const getCustomMusicRoot = () => CONFIG.sdvx_custom_music_root || process.env.SDVX_CUSTOM_MUSIC_ROOT || '';

// Cache: mid (number) -> actual folder name found on disk
const folderCache = new Map<number, string | null>();

// Cache: root path -> list of directory names (loaded once, async when possible).
// Avoids per-lookup readdirSync which would block the game event loop.
const dirListingCache = new Map<string, string[] | null>();
const dirListingLoading = new Map<string, Promise<string[] | null>>();

// Cache: "mid:type" -> best existing variant number, or null if none found.
// Skips repeated existsSync stats for the same song/difficulty.
const variantCache = new Map<string, number | null>();

async function loadDirListing(root: string): Promise<string[] | null> {
  const cached = dirListingCache.get(root);
  if (cached !== undefined) return cached;
  if (dirListingLoading.has(root)) return dirListingLoading.get(root)!;

  const p = (async () => {
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      const dirs: string[] = [];
      for (const e of entries) {
        if (e.isDirectory()) dirs.push(e.name);
      }
      dirListingCache.set(root, dirs);
      return dirs;
    } catch (e) {
      dirListingCache.set(root, null);
      return null;
    }
  })();

  dirListingLoading.set(root, p);
  try {
    return await p;
  } finally {
    dirListingLoading.delete(root);
  }
}

// Sync accessor used by findFolderOnDisk. Falls back to a one-time sync
// readdir per root ONLY if the async prewarm hasn't populated the cache yet
// (pre-warm makes this path unreachable in normal operation).
function getDirListingSync(root: string): string[] | null {
  const cached = dirListingCache.get(root);
  if (cached !== undefined) return cached;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(e.name);
    }
    dirListingCache.set(root, dirs);
    return dirs;
  } catch (e) {
    dirListingCache.set(root, null);
    return null;
  }
}

/**
 * Scan the music roots to find the folder for a given mid.
 * e.g. mid=1 -> "0001_albida_muryoku"
 * Returns null if not found.
 */
function findFolderOnDisk(mid: number): string | null {
  if (folderCache.has(mid)) return folderCache.get(mid)!;

  const mid4 = String(mid).padStart(4, '0');
  const prefix = `${mid4}_`;
  const roots = [getCustomMusicRoot(), getMusicRoot()].filter(Boolean);

  for (const root of roots) {
    const dirs = getDirListingSync(root);
    if (!dirs) continue;
    for (const name of dirs) {
      if (name.startsWith(prefix)) {
        folderCache.set(mid, name);
        return name;
      }
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

  if (getMusicRoot() || getCustomMusicRoot()) {
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
  const roots = [getCustomMusicRoot(), getMusicRoot()].filter(Boolean);
  const fname = `jk_${mid4}_${variant}.png`;
  for (const root of roots) {
    if (fs.existsSync(path.join(root, folder, fname))) return true;
  }
  return false;
}

/**
 * Best existing variant for a (mid, type) pair, cached to avoid repeated stats.
 */
function bestVariant(mid: number, type: number | string, folder: string, mid4: string): number | null {
  const key = `${mid}:${type}`;
  if (variantCache.has(key)) return variantCache.get(key)!;

  const preferred = Math.min(Number(type) + 1, 4);
  const candidates = [preferred, 4, 3, 2, 1];
  let best: number | null = null;
  for (const variant of candidates) {
    if (jacketFileExists(folder, mid4, variant)) {
      best = variant;
      break;
    }
  }
  variantCache.set(key, best);
  return best;
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

  const folder = resolveFolderName(mid);

  if (!folder) {
    // Mid not found anywhere — return dummy
    return DUMMY_JACKET_URL;
  }

  if (getMusicRoot() || getCustomMusicRoot()) {
    // Disk mode: verify which variant actually exists (cached per mid+type)
    const variant = bestVariant(Number(mid), type, folder, mid4);
    if (variant !== null) {
      return `/jackets/sdvx/${folder}/jk_${mid4}_${variant}.png`;
    }
    // No variants found — return dummy
    return DUMMY_JACKET_URL;
  }

  // Static map mode: return preferred variant URL; client-side fallback handles 404s
  const preferred = Math.min(Number(type) + 1, 4);
  return `${JACKETS_BASE_URL}/${folder}/jk_${mid4}_${preferred}.png`;
}

/**
 * If the URL is a local /jackets/sdvx/... path and the file exists on one of
 * the music roots, return the absolute filesystem path. Lets image loaders
 * read jackets straight from disk instead of round-tripping through HTTP.
 */
export function jacketDiskPath(url: string): string | null {
  // Matches both relative ("/jackets/sdvx/...") and absolute
  // ("http://127.0.0.1:PORT/jackets/sdvx/...") forms; mid can exceed 4 digits.
  const m = url.match(/\/jackets\/sdvx\/([^/]+)\/jk_(\d+)_(\d)\.png$/);
  if (!m) return null;
  const [, folder, mid4, variant] = m;
  const fname = `jk_${mid4}_${variant}.png`;
  const roots = [getCustomMusicRoot(), getMusicRoot()].filter(Boolean);
  for (const root of roots) {
    const p = path.join(root, folder, fname);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Load (and cache) the directory listing of every music root.
 * Call once at startup so jacket lookups never touch the disk synchronously.
 */
export async function prewarmJacketRoots(): Promise<void> {
  const roots = [getCustomMusicRoot(), getMusicRoot()].filter(Boolean);
  if (!roots.length) return;
  try {
    await Promise.all(roots.map(root => loadDirListing(root)));
  } catch (e) {
    // Non-fatal; sync fallback in getDirListingSync covers cold starts.
  }
}

/**
 * Pre-warm the folder cache for a list of mids.
 * Call this at startup or before rendering profiles if SDVX_MUSIC_ROOT is set,
 * to avoid per-request directory scans.
 */
export async function prewarmJacketCache(mids: (number | string)[]): Promise<void> {
  const roots = [getCustomMusicRoot(), getMusicRoot()].filter(Boolean);
  if (!roots.length) return;
  try {
    await Promise.all(roots.map(root => loadDirListing(root)));
    for (const mid of mids) {
      findFolderOnDisk(Number(mid));
    }
  } catch (e) {
    // Non-fatal.
  }
}
