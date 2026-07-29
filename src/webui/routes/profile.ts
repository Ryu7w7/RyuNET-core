import { Router, json, urlencoded } from 'express';
import {
  GetProfiles,
  Count,
  FindCardsByRefid,
  FindUserByCardNumber,
  PurgeProfile,
  FindProfile,
  FindCard,
  DeleteCard,
  CreateCard,
  UpdateProfile,
  FindUserByUsername,
  GET_DB,
  PLUGIN_PATH,
} from '../../utils/EamuseIO';
import { wrap, adminMiddleware, authMiddleware } from '../shared/middleware';
import { data, userOwnsProfile } from '../shared/helpers';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { sdvxJacketUrl } from '../../utils/sdvx_jacket_resolver';
import rateLimit from 'express-rate-limit';

// ---------------------------------------------------------------------------
// Module-level song DB cache — loaded once, never on each request
// ---------------------------------------------------------------------------
let _sdvxSongs: any = null;
let _sdvxCustomSongs: any = null;
let _iidxSongs: any = null;

// O(1) lookup maps built once from the song DBs
let _sdvxSongMap: Map<string, any> = new Map();
let _sdvxCustomSongMap: Map<string, any> = new Map();
let _iidxSongMap: Map<string, any> = new Map();

function loadSongDBs(): void {
  try {
    if (!_sdvxSongs) {
      _sdvxSongs = JSON.parse(fs.readFileSync(
        path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'music_db.json'), 'utf8'
      ));
      if (_sdvxSongs?.mdb?.music) {
        for (const s of _sdvxSongs.mdb.music) {
          _sdvxSongMap.set(String(s.id), s);
        }
      }
    }
  } catch (e) {}
  try {
    if (!_sdvxCustomSongs) {
      _sdvxCustomSongs = JSON.parse(fs.readFileSync(
        path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'custom_music_db.json'), 'utf8'
      ));
      if (_sdvxCustomSongs?.mdb?.music) {
        for (const s of _sdvxCustomSongs.mdb.music) {
          _sdvxCustomSongMap.set(String(s.id), s);
        }
      }
    }
  } catch (e) {}
  try {
    if (!_iidxSongs) {
      _iidxSongs = JSON.parse(fs.readFileSync(
        path.join(PLUGIN_PATH, 'iidx@asphyxia', 'data', 'music_data.json'), 'utf8'
      ));
      for (const [id, val] of Object.entries(_iidxSongs as any)) {
        _iidxSongMap.set(String(id), val);
      }
    }
  } catch (e) {}
}

/** Try to load DBs at startup (non-fatal if plugins aren't installed yet). */
try { loadSongDBs(); } catch (e) {}

/**
 * Maps the type index to the difficulty key used in music_db.json
 * type 0=NOV->novice, 1=ADV->advanced, 2=EXH->exhaust, 3=INF slot->infinite, 4=MXM->maximum
 */
const SDVX_TYPE_TO_JSON_KEY: Record<number, string> = {
  0: 'novice',
  1: 'advanced',
  2: 'exhaust',
  3: 'infinite',
  4: 'maximum',
};

/** Returns the first non-empty difficulty object from the difficulty array. */
function getSdvxDiffBlock(mid: number | string): any | null {
  const midStr = String(mid);
  const song = _sdvxCustomSongMap.get(midStr) || _sdvxSongMap.get(midStr);
  if (!song) return null;
  // difficulty is an array; find first element with actual keys
  if (Array.isArray(song.difficulty)) {
    for (const d of song.difficulty) {
      if (d && typeof d === 'object' && Object.keys(d).length > 0) return d;
    }
  } else if (song.difficulty && typeof song.difficulty === 'object') {
    // Fallback if it's a plain object
    return song.difficulty;
  }
  return null;
}

/**
 * Resolve level number for a given mid + type.
 * Returns a string like "18", "17.5", or null if not found/zero.
 * The JSON already stores the final value (not x10 like XML).
 */
function getSdvxLevel(mid: number | string, type: number | string): string | null {
  const t = Number(type);
  const block = getSdvxDiffBlock(mid);
  if (!block) return null;
  const key = SDVX_TYPE_TO_JSON_KEY[t];
  if (!key) return null;
  const raw = block[key];
  const num = Number(raw);
  if (!raw || !Number.isFinite(num) || num <= 0) return null;
  // Format: no trailing .0 (e.g. 18, 17.5)
  return Number.isInteger(num) ? String(num) : num.toFixed(1).replace(/\.0$/, '');
}

/**
 * Resolve the correct SDVX difficulty name + level for a given mid + type.
 * Returns strings like "MXM 18", "ADV 11", "GRV 17.5"
 *  type 0 = NOV, 1 = ADV, 2 = EXH
 *  type 3 = inf slot — actual name from inf_ver: 1=INF, 2=GRV, 3=HVN, 4=VVD, 5=MXM
 *  type 4 = MXM (separate slot in newer songs)
 */
function getSdvxDiff(mid: number | string, type: number | string): string {
  const t = Number(type);
  let name: string;
  if (t === 0) name = 'NOV';
  else if (t === 1) name = 'ADV';
  else if (t === 2) name = 'EXH';
  else if (t === 4) name = 'MXM';
  else if (t === 3) {
    const midStr = String(mid);
    const song = _sdvxCustomSongMap.get(midStr) || _sdvxSongMap.get(midStr);
    const infVer = song?.info?.inf_ver ?? null;
    const INF_NAMES: Record<number, string> = { 1: 'INF', 2: 'GRV', 3: 'HVN', 4: 'VVD', 5: 'MXM' };
    name = INF_NAMES[Number(infVer)] || 'INF';
  } else {
    name = `Diff ${t}`;
  }
  const level = getSdvxLevel(mid, type);
  return level ? `${name} ${level}` : name;
}

/** O(1) title lookup from cached maps. */
function getSdvxTitle(mid: number | string): string {
  const midStr = String(mid);
  const song = _sdvxCustomSongMap.get(midStr) || _sdvxSongMap.get(midStr);
  return song?.info?.title_name || `Song ID ${mid}`;
}

function getIidxTitle(mid: number | string): string {
  const midStr = String(mid);
  const song = _iidxSongMap.get(midStr) as any;
  return song?.title || `Song ID ${mid}`;
}

const UPLOADS_DIR = path.join((process as any).pkg ? path.dirname(process.argv0) : process.cwd(), 'uploads');
if (!fs.existsSync(path.join(UPLOADS_DIR, 'avatars'))) {
  fs.mkdirSync(path.join(UPLOADS_DIR, 'avatars'), { recursive: true });
}
if (!fs.existsSync(path.join(UPLOADS_DIR, 'banners'))) {
  fs.mkdirSync(path.join(UPLOADS_DIR, 'banners'), { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (file.fieldname === 'avatar') {
      cb(null, path.join(UPLOADS_DIR, 'avatars'));
    } else if (file.fieldname === 'banner') {
      cb(null, path.join(UPLOADS_DIR, 'banners'));
    } else {
      cb(null, UPLOADS_DIR);
    }
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const refid = req.params['refid'] || 'unknown';
    // Append a short hash/timestamp to avoid browser caching issues when users update their media
    const uniqueSuffix = Date.now().toString(36);
    cb(null, file.fieldname + '-' + refid + '-' + uniqueSuffix + ext);
  }
});

const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (jpg, png, gif, webp) are allowed.'));
    }
  }
});

// Rate limiters
const followRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: 'Too many follow/unfollow requests. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
});

const mediaRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: 'Too many file uploads. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
});

const editRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  message: 'Too many profile edits. Please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
});

export const profileRouter = Router();

// Alias Resolver: Allows using a username instead of a 16-hex refid in the URL.
// The resolver is PERMISSIVE — it tries any non-refid string as a username lookup.
// The redirect (in the GET route below) is STRICT — only redirects for URL-safe names.
profileRouter.param('refid', async (req: any, res: any, next: any, id: string) => {
  try {
    // If it's a 16 hex character string, treat it as a refid — no lookup needed
    if (/^[0-9A-F]{16}$/i.test(id)) {
      return next();
    }

    // Basic safety: reject excessively long inputs
    if (!id || id.length > 100) {
      return next();
    }

    // Try to treat as a username alias — supports any username including emails (e.g. user@example.com)
    const user = await FindUserByUsername(id);
    if (user && user.cardNumber) {
      const card = await FindCard(user.cardNumber);
      if (card && card.__refid) {
        // Overwrite the param with the real refid so all downstream routes work normally
        req.params['refid'] = card.__refid;
        return next();
      }
    }

    // Alias not found — proceed (will 404 naturally if no profile exists)
    return next();
  } catch (err) {
    return next(err);
  }
});

profileRouter.get(
  '/my-profile',
  authMiddleware,
  wrap(async (req, res) => {
    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        return res.redirect(`/profile/${card.__refid}`);
      }
    }
    req.flash('formWarn', 'Please link a Card Number in your Account settings to view your profile.');
    return res.redirect('/account');
  })
);

profileRouter.get(
  '/profiles',
  adminMiddleware,
  wrap(async (req, res) => {
    const profiles = (await GetProfiles()) || [];
    const isAdmin = req.session.user!.admin;
    for (const profile of profiles) {
      profile.cards = await Count({ __s: 'card', __refid: profile.__refid });
      profile.isOwner = await userOwnsProfile(req, profile.__refid);
      
      const profileCards = await FindCardsByRefid(profile.__refid);
      if (profileCards && profileCards.length > 0) {
        for (const c of profileCards) {
          const u = await FindUserByCardNumber(c.cid);
          if (u) {
            profile.accountUsername = u.username;
            break;
          }
        }
      }
    }
    res.render('profiles', data(req, 'Profiles', 'core', { profiles, isAdmin }));
  })
);

profileRouter.get(
  '/profile/:refid',
  wrap(async (req, res, next) => {
    const refid = req.params['refid'];
    const profile = await FindProfile(refid);
    if (!profile) return next();

    const isAdmin = req.session?.user?.admin || false;
    const isOwner = req.session?.user ? await userOwnsProfile(req, refid) : false;
    // Any user can VIEW the profile. Only admin/owner see the edit modal.

    // Privacy Logic
    if (profile.isPrivate && !isAdmin && !isOwner) {
       return res.status(403).render('403', data(req, 'Access Denied', 'core'));
    }

    let countryCode = 'xx';
    let accountCreatedAt: number | null = null;
    let accountLastLogin: number | null = null;
    let accountUsername: string | null = null;
    profile.cards = await FindCardsByRefid(refid);
    if (profile.cards && profile.cards.length > 0) {
      for (const c of profile.cards) {
        const u = await FindUserByCardNumber(c.cid);
        if (u) {
          if (u.countryCode) countryCode = u.countryCode.toLowerCase();
          if (u.createdAt) accountCreatedAt = u.createdAt;
          if (u.lastLogin) accountLastLogin = u.lastLogin;
          if (u.username) accountUsername = u.username;
          break;
        }
      }
    }

    // Redirect from raw refid URL to username alias for cleaner URLs.
    // Only redirect if the username is a valid URL-safe alias (same rules as the alias resolver).
    // Usernames with @, spaces, or other special chars will keep the refid in the URL.
    const isUrlSafeUsername = accountUsername &&
      accountUsername.length <= 64 &&
      /^[\w\-]+$/.test(accountUsername); // Only alphanumeric, underscore, hyphen (no dots, no @)
    if (isUrlSafeUsername && req.path.toLowerCase().includes(refid.toLowerCase())) {
      return res.redirect(301, `/profile/${accountUsername}`);
    }

    let sdvxStats: any = { volforce: 0, totalScores: 0, topPlays: [], recentPlays: [], firstPlaces: [] };
    let iidxStats: any = { spDan: 0, dpDan: 0, totalScores: 0, topPlays: [], recentPlays: [], firstPlaces: [] };
    let sdvxRank = null;
    let iidxRank = null;

    // Ensure DBs are loaded (no-op if already cached at module level)
    loadSongDBs();


    try {
      const { getOrBuildLeaderboardCache } = require('./leaderboard');
      
      const getRanksForGame = async (game: string, style: string) => {
         const rows = await getOrBuildLeaderboardCache(game, style);
         if (!rows) return null;
         const gRank = rows.findIndex((r: any) => String(r.refid) === String(refid));
         if (gRank < 0) return null;
         
         const natRows = rows.filter((r: any) => (r.countryCode || 'xx') === countryCode);
         const nRank = natRows.findIndex((r: any) => String(r.refid) === String(refid));
         
         return {
            globalRank: gRank + 1,
            nationalRank: nRank >= 0 ? nRank + 1 : null,
            totalGlobal: rows.length,
            totalNational: natRows.length
         };
      };

      sdvxRank = await getRanksForGame('sdvx', 'sp');
      iidxRank = await getRanksForGame('iidx', 'sp');
    } catch(e) {}

    const timeAgo = (date: any) => {
      if (!date) return 'Unknown';
      const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
      let interval = Math.floor(seconds / 31536000);
      if (interval >= 1) return interval + " year" + (interval === 1 ? "" : "s") + " ago";
      interval = Math.floor(seconds / 2592000);
      if (interval >= 1) return interval + " month" + (interval === 1 ? "" : "s") + " ago";
      interval = Math.floor(seconds / 86400);
      if (interval >= 1) return interval + " day" + (interval === 1 ? "" : "s") + " ago";
      interval = Math.floor(seconds / 3600);
      if (interval >= 1) return interval + " hour" + (interval === 1 ? "" : "s") + " ago";
      interval = Math.floor(seconds / 60);
      if (interval >= 1) return interval + " minute" + (interval === 1 ? "" : "s") + " ago";
      return Math.floor(seconds) + " seconds ago";
    };

    try {
      const sdvxDB = await GET_DB('sdvx@asphyxia');
      if (sdvxDB) {
        const records = await sdvxDB.findAsync({
          __s: 'plugins_profile',
          collection: 'music',
          __refid: refid
        });
        if (records && records.length > 0) {
          sdvxStats.totalScores = records.length;
          
          const vfRecords = records.filter((r: any) => r.volforce !== undefined);
          vfRecords.sort((a: any, b: any) => (b.volforce || 0) - (a.volforce || 0));
          const top50 = vfRecords.slice(0, 50);
          sdvxStats.volforce = top50.reduce((acc: number, cur: any) => acc + (cur.volforce || 0), 0);
          
            sdvxStats.topPlays = top50.map((play: any) => ({
              title: getSdvxTitle(play.mid),
              diff: getSdvxDiff(play.mid, play.type),
              score: play.score,
              clear: play.clear,
              volforce: Number(play.volforce / 1000).toFixed(3),
              dateStr: timeAgo(play.updatedAt),
              jacketUrl: sdvxJacketUrl(play.mid, play.type)
            }));
            // Trend
            const trendRecsSdvx = [...records].sort((a: any, b: any) => {
               const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
               const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
               return ta - tb; // Ascending for trend
            });
            let cumVf = 0;
            sdvxStats.trend = trendRecsSdvx.map((r: any) => {
               if (r.volforce && r.volforce > cumVf) cumVf = r.volforce;
               return cumVf;
            }).filter(v => v > 0);
            if (sdvxStats.trend.length === 1) sdvxStats.trend.push(sdvxStats.trend[0]);
            if (sdvxStats.trend.length > 100) {
               const step = sdvxStats.trend.length / 100;
               sdvxStats.trend = Array.from({length: 100}, (_, i) => sdvxStats.trend[Math.floor(i * step)]);
            }

            // Recent Plays
            const recentRecs = [...records].sort((a: any, b: any) => {
               const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
               const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
               return tb - ta;
            }).slice(0, 5);
            
            // Build a Set of first-place keys for O(1) lookup in recentPlays
            const { getCachedResult: _getCachedForRecent } = require('./leaderboard');
            const _cachedFirstsForRecent = (_getCachedForRecent('sdvx_firstPlaces') || []) as any[];
            const firstPlaceKeys = new Set(
              _cachedFirstsForRecent
                .filter((f: any) => String(f.refid) === String(refid))
                .map((f: any) => f.key)
            );

            sdvxStats.recentPlays = recentRecs.map((play: any) => ({
              title: getSdvxTitle(play.mid),
              diff: getSdvxDiff(play.mid, play.type),
              score: play.score,
              clear: play.clear,
              dateStr: timeAgo(play.updatedAt),
              jacketUrl: sdvxJacketUrl(play.mid, play.type),
              isFirstPlace: firstPlaceKeys.has(`${play.mid}:${play.type}`)
            }));
            
            // First Places — with timestamp from user's own records
            const { getCachedResult } = require('./leaderboard');
            const cachedFirsts = getCachedResult('sdvx_firstPlaces') || [];
            const userFirsts = (cachedFirsts as any[]).filter((f: any) => String(f.refid) === String(refid));

            // Build a Map from mid:type -> record so we can get updatedAt O(1)
            const recordsByKey = new Map<string, any>();
            for (const r of records) {
              recordsByKey.set(`${r.mid}:${r.type}`, r);
            }

            sdvxStats.firstPlaces = userFirsts.map((f: any) => {
               const [mid, type] = f.key.split(':');
               const matchedRecord = recordsByKey.get(f.key);
               return {
                  title: getSdvxTitle(mid),
                  diff: getSdvxDiff(mid, type),
                  score: f.score,
                  clear: f.clear,
                  dateStr: matchedRecord?.updatedAt ? timeAgo(matchedRecord.updatedAt) : null,
                  jacketUrl: sdvxJacketUrl(mid, type)
               };
            });
          }
        }
      } catch(e) {}

    try {
      const iidxDB = await GET_DB('iidx@asphyxia');
      if (iidxDB) {
        const pcdata = await iidxDB.findOneAsync({
          collection: 'pcdata',
          __refid: refid
        });
        if (pcdata) {
          iidxStats.spDan = pcdata.sach || 0;
          iidxStats.dpDan = pcdata.dach || 0;
        }
        
        const scores = await iidxDB.findAsync({
          collection: 'score',
          __refid: refid
        });
        if (scores && scores.length > 0) {
          // Flatten IIDX scores (asphyxia uses esArray per clid)
          const flatScores: any[] = [];
          for (const s of scores) {
             const mid = s.id || s.music_id || s.mid;
             if (!mid) continue;
             if (s.esArray && s.cArray) {
               for (let clid = 0; clid < 10; clid++) {
                 if (s.esArray[clid] > 0) {
                   flatScores.push({
                     mid: mid,
                     clid: clid,
                     ex_score: s.esArray[clid],
                     clear_flg: s.cArray[clid],
                     updatedAt: s.updatedAt
                   });
                 }
               }
             } else if ((s.ex_score || 0) > 0) {
               // Fallback for single-score format
               let clid = s.style === 1 ? s.diff + 5 : s.diff;
               if (s.cltype !== undefined) clid = s.cltype;
               if (clid === undefined) clid = -1;
               flatScores.push({
                 mid: mid,
                 clid: clid,
                 ex_score: s.ex_score,
                 clear_flg: s.clear_flg !== undefined ? s.clear_flg : s.clear_type,
                 updatedAt: s.updatedAt
               });
             }
          }
          iidxStats.totalScores = flatScores.length;

          const exScores = [...flatScores].sort((a: any, b: any) => b.ex_score - a.ex_score);
          const top50 = exScores.slice(0, 50);

          const getIidxDiffStr = (clid: number) => {
            if (clid === undefined || clid === -1) return 'Diff undefined';
            const TYPE_MAP: Record<number, string> = {
              0: 'BGN', 1: 'NRM', 2: 'HYP', 3: 'ANO', 4: 'LEG',
              6: 'NRM', 7: 'HYP', 8: 'ANO', 9: 'LEG',
            };
            const playType = clid < 5 ? 'SP' : 'DP';
            return `${playType} ${TYPE_MAP[clid] || 'Unknown'}`;
          };

          iidxStats.topPlays = top50.map((play: any) => ({
             title: getIidxTitle(play.mid),
             diff: getIidxDiffStr(play.clid),
             score: play.ex_score,
             clear: play.clear_flg,
             dateStr: timeAgo(play.updatedAt)
          }));
            // Trend
            const trendRecsIidx = [...flatScores].sort((a: any, b: any) => {
               const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
               const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
               return ta - tb; // Ascending
            });
            let cumEx = 0;
            iidxStats.trend = trendRecsIidx.map((r: any) => {
               cumEx += (Number(r.ex_score) || 0);
               return cumEx;
            }).filter(v => v > 0);
            if (iidxStats.trend.length === 1) iidxStats.trend.push(iidxStats.trend[0]);
            if (iidxStats.trend.length > 100) {
               const step = iidxStats.trend.length / 100;
               iidxStats.trend = Array.from({length: 100}, (_, i) => iidxStats.trend[Math.floor(i * step)]);
            }

            // Recent Plays
            const recentRecs = [...flatScores].sort((a: any, b: any) => {
               const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
               const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
               return tb - ta;
            }).slice(0, 5);
            
            iidxStats.recentPlays = recentRecs.map((play: any) => ({
                 title: getIidxTitle(play.mid),
                 diff: getIidxDiffStr(play.clid),
                 score: play.ex_score,
                 clear: play.clear_flg,
                 dateStr: timeAgo(play.updatedAt)
            }));
            
            // First Places (iidx) — with timestamp from user scores
            const { getCachedResult } = require('./leaderboard');
            const cachedFirsts = getCachedResult('iidx_firstPlaces') || [];
            const userFirsts = (cachedFirsts as any[]).filter((f: any) => String(f.refid) === String(refid));

            // Build a Map from score key -> score record for O(1) updatedAt lookup
            const iidxRecordsByKey = new Map<string, any>();
            for (const s of flatScores) {
              const playStyle = s.clid < 5 ? 0 : 1;
              let diff = s.clid;
              if (playStyle === 1 && s.clid >= 5) diff = s.clid - 5;
              const key = `${s.mid}:${playStyle}:${diff}`;
              iidxRecordsByKey.set(key, s);
            }

            iidxStats.firstPlaces = userFirsts.map((f: any) => {
               const [mid, style, diff] = f.key.split(':');
               let clid = Number(style) === 1 ? Number(diff) + 5 : Number(diff);
               if (diff === undefined) clid = -1;
               const matchedRecord = iidxRecordsByKey.get(f.key);
               return {
                  title: getIidxTitle(mid),
                  diff: getIidxDiffStr(clid),
                  score: f.score,
                  clear: f.clear !== undefined ? f.clear : (f.clear_flg !== undefined ? f.clear_flg : f.clear_type),
                  dateStr: matchedRecord?.updatedAt ? timeAgo(matchedRecord.updatedAt) : null
               };
            });
          }
        }
      } catch(e) {}

    const MarkdownIt = require('markdown-it');
    const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
    const bioHtml = profile.bio ? md.render(profile.bio) : '';

    const followers = Array.isArray(profile.followers) ? profile.followers : [];
    const followerCount = followers.length;
    let isFollowing = false;
    let myRefid = null;
    if (req.session?.user?.cardNumber) {
      const myCard = await FindCard(req.session.user.cardNumber);
      if (myCard && myCard.__refid) {
        myRefid = myCard.__refid;
        isFollowing = followers.includes(myRefid);
      }
    }

    const fullHost = req.protocol + '://' + req.get('host');
    let ogDescription = "No data available yet.";
    if (sdvxRank && (sdvxRank.globalRank || sdvxRank.nationalRank)) {
      const gRank = sdvxRank.globalRank ? `#${sdvxRank.globalRank.toLocaleString()}` : "N/A";
      const cRank = sdvxRank.nationalRank ? `#${sdvxRank.nationalRank.toLocaleString()}` : "N/A";
      ogDescription = `SDVX - Rank Global: ${gRank} | Country ${cRank}`;
    }
    const ogImage = profile.avatarUrl ? `${fullHost}/uploads/${profile.avatarUrl}` : `${fullHost}/static/img/avatar.jpg`;

    res.render(
      'profiles_profile',
      data(req, profile.name, 'core', {
        profile,
        countryCode,
        isAdmin,
        isOwner,
        sdvxStats,
        iidxStats,
        sdvxRank,
        iidxRank,
        bioHtml,
        followerCount,
        isFollowing,
        myRefid,
        accountCreatedAt,
        accountLastLogin,
        accountUsername,
        ogDescription,
        ogImage,
      })
    );
  })
);

profileRouter.post(
  '/profile/:refid',
  authMiddleware,
  editRateLimit,
  urlencoded({ extended: true, limit: '50mb' }),
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (!req.session.user!.admin && !(await userOwnsProfile(req, refid)))
      return res.sendStatus(403);
    
    const update: any = {};
    if (req.body.pin) {
      const pin = String(req.body.pin).replace(/\D/g, '').substring(0, 8);
      if (pin.length >= 4) update.pin = pin;
    }
    if (req.body.name) {
      const name = String(req.body.name).substring(0, 20).trim();
      if (name.length > 0) update.name = name;
    }
    if (req.body.paseli !== undefined && req.body.paseli !== '') {
      let paseli = parseInt(String(req.body.paseli), 10);
      if (!isNaN(paseli)) {
        paseli = Math.max(0, Math.min(100000, paseli));
        update.paseli = paseli;
      }
    }
    if (typeof req.body.bio === 'string') {
      update.bio = req.body.bio.substring(0, 500);
    }
    // New profile detail fields
    const simpleStr = (val: any, max = 100) =>
      typeof val === 'string' ? val.trim().substring(0, max) : undefined;
    const socialHandle = (val: any) => {
      if (typeof val !== 'string') return undefined;
      return val.trim().replace(/^@+/, '').substring(0, 50);
    };
    const webUrl = (val: any) => {
      if (typeof val !== 'string') return undefined;
      const v = val.trim().substring(0, 200);
      try { new URL(v.startsWith('http') ? v : 'https://' + v); return v; } catch { return undefined; }
    };
    if (req.body.location !== undefined)   update.location   = simpleStr(req.body.location)   ?? '';
    if (req.body.interests !== undefined)  update.interests  = simpleStr(req.body.interests)   ?? '';
    if (req.body.occupation !== undefined) update.occupation = simpleStr(req.body.occupation)  ?? '';
    if (req.body.twitter !== undefined)    update.twitter    = socialHandle(req.body.twitter)   ?? '';
    if (req.body.discord !== undefined)    update.discord    = socialHandle(req.body.discord)   ?? '';
    if (req.body.website !== undefined)    update.website    = webUrl(req.body.website)         ?? '';
    update.isPrivate = req.body.isPrivate === 'on';

    // If privacy toggled, immediately invalidate leaderboard cache so the change is instant
    const oldProfile = await FindProfile(refid);
    if (oldProfile && !!oldProfile.isPrivate !== update.isPrivate) {
      const { invalidateLeaderboardCache } = require('./leaderboard');
      invalidateLeaderboardCache();
    }

    await UpdateProfile(refid, update);
    req.flash('formOk', 'Updated');
    res.redirect(req.originalUrl);
  })
);

profileRouter.post(
  '/profile/:refid/media',
  authMiddleware,
  mediaRateLimit,
  upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'banner', maxCount: 1 }]),
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (!req.session.user!.admin && !(await userOwnsProfile(req, refid)))
      return res.sendStatus(403);
      
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const update: any = {};
    const oldProfile = await FindProfile(refid);
    
    if (files['avatar'] && files['avatar'][0]) {
      if (oldProfile && oldProfile.avatarUrl) {
        // Path traversal protection: ensure the resolved path is within UPLOADS_DIR
        const safeOld = path.resolve(UPLOADS_DIR, oldProfile.avatarUrl);
        if (safeOld.startsWith(UPLOADS_DIR + path.sep)) {
          try { fs.unlinkSync(safeOld); } catch(e) {}
        }
      }
      update.avatarUrl = 'avatars/' + files['avatar'][0].filename;
    }
    if (files['banner'] && files['banner'][0]) {
      if (oldProfile && oldProfile.bannerUrl) {
        const safeOld = path.resolve(UPLOADS_DIR, oldProfile.bannerUrl);
        if (safeOld.startsWith(UPLOADS_DIR + path.sep)) {
          try { fs.unlinkSync(safeOld); } catch(e) {}
        }
      }
      update.bannerUrl = 'banners/' + files['banner'][0].filename;
    }

    if (Object.keys(update).length > 0) {
      await UpdateProfile(refid, update);
      req.flash('formOk', 'Media uploaded successfully');
    }
    res.redirect(`/profile/${refid}`);
  })
);

profileRouter.post(
  '/profile/:refid/follow',
  authMiddleware,
  followRateLimit,
  wrap(async (req, res) => {
    const targetRefid = req.params['refid'];
    const cardNumber = req.session.user?.cardNumber;
    if (!cardNumber) return res.redirect('/account');
    
    const card = await FindCard(cardNumber);
    if (!card || !card.__refid) return res.redirect('/account');
    
    const myRefid = card.__refid;
    if (myRefid === targetRefid) return res.redirect(`/profile/${targetRefid}`); // Can't follow self
    
    const targetProfile = await FindProfile(targetRefid);
    if (!targetProfile) return res.sendStatus(404);
    
    const followers = Array.isArray(targetProfile.followers) ? targetProfile.followers : [];
    const idx = followers.indexOf(myRefid);
    
    if (idx >= 0) {
      followers.splice(idx, 1);
    } else {
      followers.push(myRefid);
    }
    
    await UpdateProfile(targetRefid, { followers });
    res.redirect(`/profile/${targetRefid}`);
  })
);

profileRouter.delete(
  '/profile/:refid',
  adminMiddleware,
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (await PurgeProfile(refid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

profileRouter.delete(
  '/card/:cid',
  authMiddleware,
  wrap(async (req, res) => {
    const cid = req.params['cid'];
    const card = await FindCard(cid);
    if (!card) return res.sendStatus(404);

    if (card.__refid) {
       const profileCards = await FindCardsByRefid(card.__refid);
       if (profileCards && profileCards.length > 0 && profileCards[0].cid === cid) {
           return res.status(400).send("Cannot delete the primary card of the profile.");
       }
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = card.__refid ? await userOwnsProfile(req, card.__refid) : false;
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    if (await DeleteCard(cid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

profileRouter.post(
  '/profile/:refid/card',
  authMiddleware,
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (!req.session.user!.admin && !(await userOwnsProfile(req, refid)))
      return res.sendStatus(403);
    
    const card = String(req.body.cid || '');
    const normalized = card
      .toUpperCase()
      .trim()
      .replace(/[\s\-]/g, '')
      .replace(/O/g, '0')
      .replace(/I/g, '1');

    if (/^[0-9A-F]{16}$/.test(normalized)) {
      if (!(await FindCard(normalized))) {
        await CreateCard(normalized, refid, normalized);
      }
    }
    res.sendStatus(200);
  })
);
