import { loadImage, Image } from '@napi-rs/canvas';
import { CONFIG } from '../utils/ArgConfig';
import { jacketDiskPath } from '../utils/sdvx_jacket_resolver';

// In-memory decoded-image cache shared by /rs and /b50. Bounded with simple
// FIFO eviction so repeat commands don't re-download the same jackets.
const MAX_CACHE_IMAGES = 300;
const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 8;

const cache = new Map<string, Image>();
const pending = new Map<string, Promise<Image | null>>();

function cacheSet(url: string, img: Image) {
  cache.delete(url);
  cache.set(url, img);
  if (cache.size > MAX_CACHE_IMAGES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Convert local /jackets/... paths to a loadable URL (same as before). */
export function absolutizeJacketUrl(url: string): string {
  if (url.startsWith('/')) return `http://127.0.0.1:${CONFIG.port}${url}`;
  return url;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('jacket load timeout')), ms);
    p.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Try a single URL: disk first (local /jackets path), then HTTP. Caches hits.
async function loadOne(url: string): Promise<Image | null> {
  const cached = cache.get(url);
  if (cached) return cached;

  const diskPath = jacketDiskPath(url);
  try {
    const img = diskPath
      ? await withTimeout(loadImage(diskPath), FETCH_TIMEOUT_MS)
      : await withTimeout(loadImage(url), FETCH_TIMEOUT_MS);
    cacheSet(url, img);
    return img;
  } catch (e) {
    return null;
  }
}

// Build the list of fallback variant URLs (_N.png, lower N) for a failed URL.
function variantUrls(url: string): string[] {
  const match = url.match(/_(\d)\.png$/);
  if (!match) return [];
  let variant = parseInt(match[1], 10);
  const out: string[] = [];
  while (variant > 1) {
    variant--;
    out.push(url.replace(/_(\d)\.png$/, `_${variant}.png`));
  }
  return out;
}

/**
 * Load a jacket (cached). On failure, tries lower variants in parallel and
 * returns the first one that succeeds. Returns null only if every attempt
 * failed — callers should draw a placeholder.
 */
export async function loadJacketWithCache(url: string): Promise<Image | null> {
  const abs = absolutizeJacketUrl(url);
  const cached = cache.get(abs);
  if (cached) return cached;
  if (pending.has(abs)) return pending.get(abs)!;

  const p = (async () => {
    const primary = await loadOne(abs);
    if (primary) return primary;

    const variants = variantUrls(abs);
    if (variants.length) {
      const results = await Promise.all(variants.map(v => loadOne(v)));
      const ok = results.find(r => r !== null);
      if (ok) return ok;
    }
    return null;
  })();

  pending.set(abs, p);
  try {
    return await p;
  } finally {
    pending.delete(abs);
  }
}

/**
 * Load many jackets with a concurrency cap. Duplicate URLs are only fetched
 * once. Returns a Map of url -> Image|null (null = placeholder).
 */
export async function loadManyJackets(
  urls: string[],
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<Map<string, Image | null>> {
  const uniq = [...new Set(urls)];
  const results = new Map<string, Image | null>();
  let idx = 0;

  async function worker() {
    while (idx < uniq.length) {
      const url = uniq[idx++];
      results.set(url, await loadJacketWithCache(url));
    }
  }

  const workers: Promise<void>[] = [];
  const count = Math.min(concurrency, uniq.length);
  for (let i = 0; i < count; i++) workers.push(worker());
  await Promise.all(workers);

  return results;
}
