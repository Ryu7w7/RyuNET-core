import { Router } from 'express';
import { groupBy } from 'lodash';
import {
  FindCardsByRefid,
  FindUserByCardNumber,
  FindCard,
  GetProfiles,
  GET_DB,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';
import { data } from '../shared/helpers';

export const leaderboardRouter = Router();

// --- Caching Logic ---
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const leaderboardCache = new Map<string, { data: any; timestamp: number }>();

export function getCachedResult(key: string) {
  const cached = leaderboardCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

export function setCachedResult(key: string, value: any) {
  leaderboardCache.set(key, { data: value, timestamp: Date.now() });
}

export function invalidateLeaderboardCache() {
  leaderboardCache.clear();
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

function getDDRNickname(docs: any[]) {
  for (const d of docs) {
    if (d?.collection === 'profile3' && typeof d?.dancerName === 'string' && d.dancerName.trim().length > 0) {
      return d.dancerName.trim();
    }
  }
  for (const d of docs) {
    if (d?.collection === 'profile') {
      const str = d?.usergamedata?.COMMON?.strdata;
      if (typeof str === 'string') {
        const parts = str.split(',');
        if (parts[25] && parts[25].trim().length > 0 && parts[25].trim() !== 'undefined') {
          return parts[25].trim();
        }
      }
    }
  }
  return null;
}

async function resolveCountryCode(refid: string, coreProfile: any): Promise<string> {
  if (coreProfile?.countryCode) {
    return coreProfile.countryCode.toLowerCase();
  }
  const cards = await FindCardsByRefid(refid);
  for (const c of cards || []) {
    const u = await FindUserByCardNumber(c.cid);
    if (u?.countryCode) {
      return u.countryCode.toLowerCase();
    }
  }
  return 'xx';
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

export async function getOrBuildLeaderboardCache(game: string, style: string) {
  const cacheKey = `${game}_${style}`;
  let rows = getCachedResult(cacheKey);
  if (rows) return rows;

  const allProfiles = (await GetProfiles()) || [];
  const profileMap = new Map(allProfiles.map((p: any) => [String(p.__refid), p]));

  if (game === 'sdvx') {
    const db = await GET_DB('sdvx@asphyxia');
    if (!db) {
      setCachedResult(cacheKey, []);
      return [];
    }
    
    const docs = await db.findAsync<any>({ __s: 'plugins_profile' }, {}).sort({ createdAt: 1 }).execAsync();
    const byRef = groupBy(docs, '__refid');
    const sdvxRows: any[] = [];
    const globalFirstPlaces = new Map<string, { score: number, refid: string }>();
    
    for (const refid in byRef) {
      const coreProfile: any = profileMap.get(refid);
      if (coreProfile?.isPrivate) continue;

      const bestByChart = new Map<string, number>();
      for (const d of byRef[refid]) {
        if (d.collection === 'music' && d.mid != null && d.type != null) {
          if (typeof d.volforce === 'number' && d.volforce > 0) {
            const key = `${d.mid}:${d.type}`;
            bestByChart.set(key, Math.max(bestByChart.get(key) ?? 0, d.volforce));
          }
          if (typeof d.score === 'number' && d.score > 0) {
            const key = `${d.mid}:${d.type}`;
            const existing = globalFirstPlaces.get(key);
            if (!existing || d.score > existing.score) {
              globalFirstPlaces.set(key, { score: d.score, refid });
            }
          }
        }
      }
      if (bestByChart.size === 0) continue;
      
      const sumTop50 = Array.from(bestByChart.values()).sort((a, b) => b - a).slice(0, 50).reduce((a, b) => a + b, 0);
      const vfTotal = sumTop50 / 1000;
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
        avatarUrl: (coreProfile as any)?.avatarUrl || null,
      });
    }
    sdvxRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    sdvxRows.forEach((r, idx) => r.globalRank = idx + 1);
    rows = sdvxRows;
    
    const firstPlacesArr = Array.from(globalFirstPlaces.entries()).map(([k, v]) => ({ key: k, score: v.score, refid: v.refid }));
    setCachedResult('sdvx_firstPlaces', firstPlacesArr);
  } 
  else if (game === 'iidx') {
    const db = await GET_DB('iidx@asphyxia');
    if (!db) {
      setCachedResult(cacheKey, []);
      return [];
    }
    
    const isSP = style === 'sp';
    const isDP = style === 'dp';
    const docs = await db.findAsync<any>({ __s: 'plugins_profile' }, {}).sort({ createdAt: 1 }).execAsync();
    const byRef = groupBy(docs, '__refid');
    const iidxRows: any[] = [];
    const globalFirstPlaces = new Map<string, { score: number, refid: string }>();
    
    for (const refid in byRef) {
      const coreProfile: any = profileMap.get(refid);
      if (coreProfile?.isPrivate) continue;

      let totalEX = 0, entries = 0;
      for (const d of byRef[refid]) {
        if (d.collection !== 'score') continue;
        const exScore = Number(d.ex_score) || 0;
        if (exScore > 0) {
           const songId = d.id || d.music_id || d.mid;
           if (songId != null && d.diff != null && d.style != null) {
              const key = `${songId}:${d.style}:${d.diff}`;
              const existing = globalFirstPlaces.get(key);
              if (!existing || exScore > existing.score) {
                 globalFirstPlaces.set(key, { score: exScore, refid });
              }
           }
        }
      }
      for (const d of byRef[refid]) {
        if (d.collection !== 'activity_mybest') continue;
        const playStyle = Number(d.play_style);
        if ((isSP && playStyle !== 0) || (isDP && playStyle !== 1)) continue;
        const score = Math.max(Number(d.best_score) || 0, Number(d.now_score) || 0);
        if (score > 0) { totalEX += score; entries++; }
      }
      if (totalEX <= 0) continue;
      
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
      iidxRows.push({ refid, name, value: totalEX, extraA: entries, countryCode, avatarUrl: (coreProfile as any)?.avatarUrl || null });
    }
    iidxRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    iidxRows.forEach((r, idx) => r.globalRank = idx + 1);
    rows = iidxRows;

    const firstPlacesArr = Array.from(globalFirstPlaces.entries()).map(([k, v]) => ({ key: k, score: v.score, refid: v.refid }));
    setCachedResult('iidx_firstPlaces', firstPlacesArr);
  }
  else if (game === 'ddr') {
    const db = await GET_DB('ddr@asphyxia');
    if (!db) {
      setCachedResult(cacheKey, []);
      return [];
    }

    const isSP = style !== 'dp'; // default is sp
    const docs = await db.findAsync<any>({ __s: 'plugins_profile' }, {}).sort({ createdAt: 1 }).execAsync();
    const byRef = groupBy(docs, '__refid');
    const ddrRows: any[] = [];
    const globalFirstPlaces = new Map<string, { score: number, refid: string }>();

    for (const refid in byRef) {
      const coreProfile: any = profileMap.get(refid);
      if (coreProfile?.isPrivate) continue;

      const bestByChart = new Map<string, { exScore: number, score: number }>();
      for (const d of byRef[refid]) {
        if (d.collection === 'score3') {
          const docStyle = Number(d.style);
          if ((isSP && docStyle !== 0) || (!isSP && docStyle !== 1)) continue;
          const ex = Number(d.exScore) || 0;
          const sc = Number(d.score) || 0;
          if (d.songId != null && d.difficulty != null) {
            const key = `${d.songId}:${d.difficulty}`;
            const prev = bestByChart.get(key) || { exScore: 0, score: 0 };
            bestByChart.set(key, {
              exScore: Math.max(prev.exScore, ex),
              score: Math.max(prev.score, sc),
            });
            if (ex > 0) {
              const gKey = `${d.songId}:${d.style}:${d.difficulty}`;
              const existing = globalFirstPlaces.get(gKey);
              if (!existing || ex > existing.score) {
                globalFirstPlaces.set(gKey, { score: ex, refid });
              }
            }
          }
        } else if (d.collection === 'score') {
          let docStyle = d.style;
          let diff = Number(d.difficulty);
          if (docStyle === undefined) {
            docStyle = diff < 5 ? 0 : 1;
            if (diff >= 5) diff -= 5;
          } else {
            docStyle = Number(docStyle);
          }
          if ((isSP && docStyle !== 0) || (!isSP && docStyle !== 1)) continue;
          const ex = Number(d.exScore) || 0;
          const sc = Number(d.score) || 0;
          if (d.songId != null && diff != null) {
            const key = `${d.songId}:${diff}`;
            const prev = bestByChart.get(key) || { exScore: 0, score: 0 };
            bestByChart.set(key, {
              exScore: Math.max(prev.exScore, ex),
              score: Math.max(prev.score, sc),
            });
            if (ex > 0) {
              const gKey = `${d.songId}:${docStyle}:${diff}`;
              const existing = globalFirstPlaces.get(gKey);
              if (!existing || ex > existing.score) {
                globalFirstPlaces.set(gKey, { score: ex, refid });
              }
            }
          }
        }
      }

      if (bestByChart.size === 0) continue;

      const totalEX = Array.from(bestByChart.values()).reduce((sum, v) => sum + v.exScore, 0);
      const totalScore = Array.from(bestByChart.values()).reduce((sum, v) => sum + v.score, 0);
      if (totalEX <= 0 && totalScore <= 0) continue;

      const rankValue = totalEX > 0 ? totalEX : totalScore;
      const nickname = getDDRNickname(byRef[refid]);
      const name = nickname ? sanitizeNickname(nickname) : (coreProfile?.name || '(no name)');
      const countryCode = await resolveCountryCode(refid, coreProfile);

      ddrRows.push({
        refid,
        name,
        value: rankValue,
        extraA: bestByChart.size,
        mode: isSP ? 'SP' : 'DP',
        countryCode,
        avatarUrl: (coreProfile as any)?.avatarUrl || null,
      });
    }

    ddrRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    ddrRows.forEach((r, idx) => r.globalRank = idx + 1);
    rows = ddrRows;

    const firstPlacesArr = Array.from(globalFirstPlaces.entries()).map(([k, v]) => ({ key: k, score: v.score, refid: v.refid }));
    setCachedResult('ddr_firstPlaces', firstPlacesArr);
  }
  else if (game === 'popn') {
    const db = await GET_DB('popn@asphyxia');
    if (!db) {
      setCachedResult(cacheKey, []);
      return [];
    }

    const isScoreMode = style === 'score';
    const docs = await db.findAsync<any>({ __s: 'plugins_profile' }, {}).sort({ createdAt: 1 }).execAsync();
    const byRef = groupBy(docs, '__refid');
    const popnRows: any[] = [];
    const globalFirstPlaces = new Map<string, { score: number, refid: string }>();

    for (const refid in byRef) {
      const coreProfile: any = profileMap.get(refid);
      if (coreProfile?.isPrivate) continue;

      let maxPowerPoint = 0;
      let popnTier = 0;
      const bestScores = new Map<string, { score: number, clear_type: number }>();

      for (const doc of byRef[refid]) {
        if (doc.collection === 'params' && doc.params) {
          const pp = Number(doc.params.power_point) || 0;
          if (pp > maxPowerPoint) {
            maxPowerPoint = pp;
            popnTier = Number(doc.params.popn_class) || 0;
          }
        }
        if (doc.collection === 'scores' && doc.scores && typeof doc.scores === 'object') {
          for (const [key, val] of Object.entries(doc.scores as Record<string, any>)) {
            if (val && typeof val.score === 'number' && val.score > 0) {
              const prev = bestScores.get(key) || { score: 0, clear_type: 0 };
              const newScore = Math.max(prev.score, val.score);
              const newClear = Math.max(prev.clear_type, Number(val.clear_type) || 0);
              bestScores.set(key, { score: newScore, clear_type: newClear });

              const existing = globalFirstPlaces.get(key);
              if (!existing || newScore > existing.score) {
                globalFirstPlaces.set(key, { score: newScore, refid });
              }
            }
          }
        }
      }

      if (bestScores.size === 0 && maxPowerPoint === 0) continue;

      const totalScore = Array.from(bestScores.values()).reduce((sum, v) => sum + v.score, 0);
      const totalClears = Array.from(bestScores.values()).filter(v => v.clear_type >= 200).length;
      const popnClassVal = maxPowerPoint / 100;

      const nickname = getGameNickname(byRef[refid]);
      const name = nickname ? sanitizeNickname(nickname) : (coreProfile?.name || '(no name)');
      const countryCode = await resolveCountryCode(refid, coreProfile);

      if (isScoreMode) {
        if (totalScore <= 0) continue;
        popnRows.push({
          refid,
          name,
          value: totalScore,
          extraA: bestScores.size,
          extraB: totalClears,
          popnClass: popnClassVal,
          popnTier,
          countryCode,
          avatarUrl: (coreProfile as any)?.avatarUrl || null,
        });
      } else {
        if (popnClassVal <= 0 && totalScore <= 0) continue;
        popnRows.push({
          refid,
          name,
          value: popnClassVal,
          totalScore,
          extraA: bestScores.size,
          extraB: totalClears,
          popnClass: popnClassVal,
          popnTier,
          countryCode,
          avatarUrl: (coreProfile as any)?.avatarUrl || null,
        });
      }
    }

    if (isScoreMode) {
      popnRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    } else {
      popnRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || ((b.totalScore ?? 0) - (a.totalScore ?? 0)));
    }

    popnRows.forEach((r, idx) => r.globalRank = idx + 1);
    rows = popnRows;

    const firstPlacesArr = Array.from(globalFirstPlaces.entries()).map(([k, v]) => ({ key: k, score: v.score, refid: v.refid }));
    setCachedResult('popn_firstPlaces', firstPlacesArr);
  }
  else {
    return null;
  }

  if (rows) setCachedResult(cacheKey, rows);
  return rows;
}

// --- Route Handler ---
leaderboardRouter.get('/leaderboard', wrap(async (req, res, next) => {
  let game = String(req.query.game || 'sdvx').toLowerCase().trim();
  if (game === "pop'n") game = 'popn';
  const defaultStyle = game === 'popn' ? 'class' : 'sp';
  const style = String(req.query.style || defaultStyle).toLowerCase().trim();
  
  const perPage = 20;
  const page = clampInt(req.query.page, 1, 1, 999999);
  const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const selectedCountry = typeof req.query.country === 'string' ? req.query.country.toLowerCase().trim() : '';

  let rows = await getOrBuildLeaderboardCache(game, style);

  if (rows === null) {
    return res.redirect('/leaderboard?game=sdvx');
  }

  // Extract available unique countries from all rows
  function getFlagEmoji(countryCode: string) {
    if (!countryCode || countryCode === 'xx') return '🌎';
    const codePoints = countryCode
      .toUpperCase()
      .split('')
      .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
  }

  const availableCountries = Array.from(new Set<string>(rows.map((r: any) => r.countryCode || 'xx')))
    .sort()
    .map(code => ({
      code,
      emoji: getFlagEmoji(code),
    }));

  // Filtering
  let filteredRows = rows.map((r: any) => ({ ...r })); // Clone to avoid cache corruption
  if (selectedCountry && selectedCountry !== 'all' && selectedCountry !== 'xx') {
    filteredRows = filteredRows.filter((r: any) => (r.countryCode || 'xx') === selectedCountry);
  }
  if (searchQuery) {
    const sq = searchQuery.toLowerCase();
    filteredRows = filteredRows.filter((r: any) => r.name && r.name.toLowerCase().includes(sq));
  }

  // Recalculate ranks for the filtered view
  filteredRows.forEach((r: any, idx: number) => {
    r.localRank = idx + 1;
  });

  // Dynamically attach the latest avatarUrl and name to bypass the 5-minute cache
  try {
    const allProfiles = await GetProfiles();
    if (allProfiles && Array.isArray(allProfiles)) {
      const profileMap = new Map(allProfiles.map((p: any) => [String(p.__refid), p]));
      filteredRows.forEach((r: any) => {
        const p = profileMap.get(String(r.refid));
        if (p) {
          if (p.avatarUrl !== undefined) r.avatarUrl = p.avatarUrl;
          if (p.name) r.name = p.name;
        }
      });
    }
  } catch(e) {}

  const myRefid = await getLoggedRefid(req);
  let myRank = null, myRow = null, myLocalRank = null;
  if (myRefid) {
    const idx = rows.findIndex((r: any) => String(r.refid) === String(myRefid));
    if (idx >= 0) {
      myRank = idx + 1;
      myRow = rows[idx];
      
      const lIdx = filteredRows.findIndex((r: any) => String(r.refid) === String(myRefid));
      if (lIdx >= 0) {
        myLocalRank = lIdx + 1;
      }
    }
  }

  const totalPlayers = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / perPage));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((safePage - 1) * perPage, safePage * perPage);

  return res.render('leaderboard', data(req, 'Leaderboard', 'core', {
    game, style, rows: pageRows, totalPlayers, globalTotalPlayers: rows.length,
    searchQuery, selectedCountry, availableCountries, totalPages, page: safePage, perPage, myRank, myRow, myLocalRank,
    getFlagEmoji, // Also passing helper to template if needed for the current selected country
  }));
}));
