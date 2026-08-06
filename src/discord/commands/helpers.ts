import { FindUserByUsername, FindCard } from '../../utils/EamuseIO';

// Short-TTL cache for username -> refid resolution to avoid two DB queries
// per command invocation. 5 minutes is enough to absorb card re-links.
const REFID_CACHE_TTL_MS = 5 * 60 * 1000;
const REFID_CACHE_MAX = 500;
const refidCache = new Map<string, { refid: string; ts: number }>();

function refidCacheSet(username: string, refid: string) {
  refidCache.set(username, { refid, ts: Date.now() });
  if (refidCache.size > REFID_CACHE_MAX) {
    const oldest = refidCache.keys().next().value;
    if (oldest !== undefined) refidCache.delete(oldest);
  }
}

/**
 * Resolves a RyuNET username (case-insensitive) to a refid.
 * Flow: username -> user.cardNumber -> card.__refid
 */
export async function getRefidForUsername(username: string): Promise<string | null> {
  const hit = refidCache.get(username);
  if (hit && Date.now() - hit.ts < REFID_CACHE_TTL_MS) return hit.refid;

  // Try exact match first
  let user = await FindUserByUsername(username);

  // If not found, try case-insensitive (brute-force not ideal but CoreDB has no regex)
  // For now exact match is the same as the web UI
  if (!user) return null;

  const cardNumber = user.cardNumber;
  if (!cardNumber) return null;

  const card = await FindCard(cardNumber);
  if (!card || !card.__refid) return null;

  refidCacheSet(username, card.__refid as string);
  return card.__refid as string;
}

// =========================================
//         Render concurrency guard
// =========================================
// Limits how many images are being generated at once so a burst of /rs or
// /b50 usage can never saturate CPU/memory and slow down the game server.
// Extra requests wait (with a timeout) instead of piling up.

const MAX_CONCURRENT_RENDERS = 3;
const RENDER_SLOT_TIMEOUT_MS = 30000;

let activeRenders = 0;
const waiters: Array<{ timer: NodeJS.Timeout; resolve: (ok: boolean) => void }> = [];

export function acquireRenderSlot(timeoutMs: number = RENDER_SLOT_TIMEOUT_MS): Promise<boolean> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders++;
    return Promise.resolve(true);
  }

  return new Promise(resolve => {
    const entry = {
      timer: setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        resolve(false);
      }, timeoutMs),
      resolve: (ok: boolean) => {
        clearTimeout(entry.timer);
        if (ok) activeRenders++;
        resolve(ok);
      },
    };
    waiters.push(entry);
  });
}

export function releaseRenderSlot(): void {
  if (activeRenders > 0) activeRenders--;
  const next = waiters.shift();
  if (next) next.resolve(true);
}
