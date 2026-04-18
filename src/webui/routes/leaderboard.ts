import { Router } from 'express';
import { groupBy } from 'lodash';
import {
  APIFind,
  FindProfile,
  FindCardsByRefid,
  FindUserByCardNumber,
  FindCard,
} from '../../utils/EamuseIO';
import { ROOT_CONTAINER } from '../../eamuse/index';
import { wrap } from '../shared/middleware';
import { data } from '../shared/helpers';

export const leaderboardRouter = Router();

// --- Caching Logic ---
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const leaderboardCache = new Map<string, { data: any; timestamp: number }>();

function getCachedResult(key: string) {
  const cached = leaderboardCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

function setCachedResult(key: string, value: any) {
  leaderboardCache.set(key, { data: value, timestamp: Date.now() });
}

// --- Helpers ---
function sanitizeNickname(name: string) {
  const banned = ['nigger', 'nigga', 'faggot', 'kike', 'spic', 'chink', 'retard'];
  const lower = name.toLowerCase();
  if (banned.some(w => lower.includes(w))) return 'CENSORED';
  return name;
}

function getGameNickname(docs: any[]) {
  for (const d of docs) {
    if (d?.collection === 'profile' && typeof d?.name === 'string' && d.name.trim().length > 0) {
      return d.name.trim();
    }
  }
  return null;
}

function vfToClassNum(vf: number) {
  if (vf >= 20.0) return 10;
  if (vf >= 19.0) return 9;
  if (vf >= 18.0) return 8;
  if (vf >= 17.0) return 7;
  if (vf >= 16.0) return 6;
  if (vf >= 15.0) return 5;
  if (vf >= 14.0) return 4;
  if (vf >= 12.0) return 3;
  if (vf >= 10.0) return 2;
  return 1;
}

function classNumToName(n: number) {
  const names = ['SIENNA', 'COBALT', 'DANDELION', 'CYAN', 'SCARLET', 'CORAL', 'ARGENTO', 'ELDORA', 'CRIMSON', 'IMPERIAL'];
  return names[n - 1] ?? 'SIENNA';
}

function clampInt(v: any, def: number, min: number, max: number) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

async function getLoggedRefid(req: any) {
  const cardNumber = req.session?.user?.cardNumber;
  if (!cardNumber) return null;
  const card = await FindCard(cardNumber);
  return card ? card.__refid : null;
}

// --- Route Handler ---
leaderboardRouter.get('/leaderboard', wrap(async (req, res, next) => {
  const game = String(req.query.game || 'sdvx').toLowerCase();
  const style = String(req.query.style || 'sp').toLowerCase();
  const cacheKey = `${game}_${style}`;
  
  const perPage = 20;
  const page = clampInt(req.query.page, 1, 1, 999999);
  const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  let rows = getCachedResult(cacheKey);

  if (!rows) {
    // Heavy calculation if not cached
    if (game === 'sdvx') {
      const plugin = ROOT_CONTAINER.getPluginByID('sdvx@asphyxia');
      if (!plugin) return next();
      
      const docs = await APIFind({ identifier: plugin.Identifier, core: true }, null, {});
      const byRef = groupBy(docs, '__refid');
      const sdvxRows: any[] = [];
      
      for (const refid in byRef) {
        const bestByChart = new Map<string, number>();
        for (const d of byRef[refid]) {
          if (d.collection === 'music' && typeof d.volforce === 'number' && d.volforce > 0 && d.mid != null && d.type != null) {
            const key = `${d.mid}:${d.type}`;
            bestByChart.set(key, Math.max(bestByChart.get(key) ?? 0, d.volforce));
          }
        }
        if (bestByChart.size === 0) continue;
        
        const sumTop50 = Array.from(bestByChart.values()).sort((a, b) => b - a).slice(0, 50).reduce((a, b) => a + b, 0);
        const vfTotal = sumTop50 / 1000;
        const coreProfile: any = await FindProfile(refid);
        const nickname = getGameNickname(byRef[refid]);
        const name = nickname ? sanitizeNickname(nickname) : (coreProfile?.name || '(no name)');
        const classNum = vfToClassNum(vfTotal);
        
        let countryCode = 'xx';
        if (coreProfile?.countryCode) {
          countryCode = coreProfile.countryCode.toLowerCase();
        } else {
          const cards = await FindCardsByRefid(refid);
          for (const c of cards || []) {
            const u = await FindUserByCardNumber(c.cid);
            if (u?.countryCode) { countryCode = u.countryCode.toLowerCase(); break; }
          }
        }
        
        sdvxRows.push({
          refid, name, value: vfTotal, extraA: bestByChart.size,
          classNum, className: classNumToName(classNum),
          classImg: `/plugin/sdvx@asphyxia/static/asset/force/em6_${String(classNum).padStart(2, '0')}_i_eab.png`,
          countryCode,
        });
      }
      sdvxRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      sdvxRows.forEach((r, idx) => r.globalRank = idx + 1);
      rows = sdvxRows;
    } 
    else if (game === 'iidx') {
      const plugin = ROOT_CONTAINER.getPluginByID('iidx@asphyxia');
      if (!plugin) return next();
      
      const isSP = style === 'sp';
      const isDP = style === 'dp';
      const docs = await APIFind({ identifier: plugin.Identifier, core: true }, null, {});
      const byRef = groupBy(docs, '__refid');
      const iidxRows: any[] = [];
      
      for (const refid in byRef) {
        let totalEX = 0, entries = 0;
        for (const d of byRef[refid]) {
          if (d.collection !== 'activity_mybest') continue;
          const playStyle = Number(d.play_style);
          if ((isSP && playStyle !== 0) || (isDP && playStyle !== 1)) continue;
          const score = Math.max(Number(d.best_score) || 0, Number(d.now_score) || 0);
          if (score > 0) { totalEX += score; entries++; }
        }
        if (totalEX <= 0) continue;
        
        const coreProfile: any = await FindProfile(refid);
        const nickname = getGameNickname(byRef[refid]);
        const name = nickname ? sanitizeNickname(nickname) : (coreProfile?.name || '(no name)');
        
        let countryCode = 'xx';
        if (coreProfile?.countryCode) {
          countryCode = coreProfile.countryCode.toLowerCase();
        } else {
          const cards = await FindCardsByRefid(refid);
          for (const c of cards || []) {
            const u = await FindUserByCardNumber(c.cid);
            if (u?.countryCode) { countryCode = u.countryCode.toLowerCase(); break; }
          }
        }
        iidxRows.push({ refid, name, value: totalEX, extraA: entries, countryCode });
      }
      iidxRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      iidxRows.forEach((r, idx) => r.globalRank = idx + 1);
      rows = iidxRows;
    }

    if (rows) setCachedResult(cacheKey, rows);
  }

  if (!rows) return next();

  // Filtering and Pagination (Always fresh based on request)
  let filteredRows = rows;
  if (searchQuery) {
    const sq = searchQuery.toLowerCase();
    filteredRows = rows.filter((r: any) => r.name && r.name.toLowerCase().includes(sq));
  }

  const myRefid = await getLoggedRefid(req);
  let myRank = null, myRow = null;
  if (myRefid) {
    const idx = rows.findIndex((r: any) => String(r.refid) === String(myRefid));
    if (idx >= 0) {
      myRank = idx + 1;
      myRow = rows[idx];
    }
  }

  const totalPlayers = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / perPage));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((safePage - 1) * perPage, safePage * perPage);

  return res.render('leaderboard', data(req, 'Leaderboard', 'core', {
    game, style, rows: pageRows, totalPlayers, globalTotalPlayers: rows.length,
    searchQuery, totalPages, page: safePage, perPage, myRank, myRow,
  }));
}));
