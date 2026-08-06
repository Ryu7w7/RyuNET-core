import { GlobalFonts } from '@napi-rs/canvas';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from '../utils/Logger';

// Family alias we register any system CJK font under. Kept first in the
// renderer's font stack so Japanese titles / symbols render on Linux/ARM,
// where Windows-only fonts (Meiryo, Yu Gothic) don't exist.
export const CJK_FONT_FAMILY = 'RyuNET CJK';

// Well-known locations (Debian/Ubuntu fonts-noto-cjk, source-han, wqy...).
const KNOWN_FONT_PATHS: string[] = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf',
  '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansJP-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansJP-Bold.ttf',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/source-han-sans/SourceHanSans-Regular.otc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
];

const FONT_SCAN_DIRS = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts')];

const FONT_FILE_RE = /\.(ttc|otc|ttf|otf)$/i;
const CJK_HINT_RE = /(cjk|noto|wqy|han|gothic|mincho|meiryo|msgothic|msyh|fallback|ipa)/i;

function findCjkFontFiles(): string[] {
  const found = new Set<string>();
  for (const p of KNOWN_FONT_PATHS) {
    if (fs.existsSync(p)) found.add(p);
  }
  if (found.size > 0) return [...found];

  // Bounded recursive scan as a last resort (one-time, at bot startup).
  const maxFiles = 5000;
  let scanned = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || scanned >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (scanned >= maxFiles) return;
      scanned++;
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && FONT_FILE_RE.test(e.name) && CJK_HINT_RE.test(e.name)) {
        found.add(path.join(dir, e.name));
      }
    }
  };
  for (const dir of FONT_SCAN_DIRS) walk(dir, 0);
  return [...found];
}

// Whether the system already exposes a CJK-capable family to skia (Windows
// ships Meiryo/Yu Gothic natively, so no registration is needed there).
const SYSTEM_CJK_RE = /(noto|cjk|meiryo|yu gothic|msgothic|ms p gothic|msyh|wenquanyi|wqy|source han|han sans|ipa)/i;

function systemHasCjkFont(): boolean {
  try {
    return GlobalFonts.families.some(f => SYSTEM_CJK_RE.test(String(f.family)));
  } catch {
    return false;
  }
}

let registered = false;

/**
 * Register the first CJK font found on the system under a stable family
 * alias. Safe to call multiple times (no-op after the first success).
 * Never throws — Discord rendering must not affect the game server.
 */
export function registerDiscordFonts(): void {
  if (registered) return;
  registered = true;

  try {
    if (systemHasCjkFont()) return;

    for (const file of findCjkFontFiles()) {
      try {
        if (GlobalFonts.registerFromPath(file, CJK_FONT_FAMILY)) {
          Logger.info(`[Discord] Registered CJK font for image rendering: ${file}`);
          return;
        }
      } catch (e) {
        // try next candidate
      }
    }

    if (!systemHasCjkFont()) {
      Logger.warn(
        '[Discord] No CJK font found on this system — Japanese titles may render as boxes. Install fonts-noto-cjk (Linux) or a Japanese font.'
      );
    }
  } catch (e) {
    Logger.warn(`[Discord] Font registration failed (non-fatal): ${e}`);
  }
}
