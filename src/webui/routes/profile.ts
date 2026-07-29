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
  GET_DB,
  PLUGIN_PATH,
} from '../../utils/EamuseIO';
import { wrap, adminMiddleware } from '../shared/middleware';
import { data, userOwnsProfile } from '../shared/helpers';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { sdvxJacketUrl } from '../../utils/sdvx_jacket_resolver';
import rateLimit from 'express-rate-limit';

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

profileRouter.get(
  '/my-profile',
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

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    // Any logged-in user can VIEW the profile. Only admin/owner see the edit modal.

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

    let sdvxStats: any = { volforce: 0, totalScores: 0, topPlays: [], recentPlays: [], firstPlaces: [] };
    let iidxStats: any = { spDan: 0, dpDan: 0, totalScores: 0, topPlays: [], recentPlays: [], firstPlaces: [] };
    let sdvxRank = null;
    let iidxRank = null;

    let sdvxSongs: any = null;
    let sdvxCustomSongs: any = null;
    let iidxSongs: any = null;
    try {
      if (!sdvxSongs) sdvxSongs = JSON.parse(require('fs').readFileSync(path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'music_db.json'), 'utf8'));
      try {
        if (!sdvxCustomSongs) sdvxCustomSongs = JSON.parse(require('fs').readFileSync(path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json', 'custom_music_db.json'), 'utf8'));
      } catch (e) {}
      if (!iidxSongs) iidxSongs = JSON.parse(require('fs').readFileSync(path.join(PLUGIN_PATH, 'iidx@asphyxia', 'data', 'music_data.json'), 'utf8'));
    } catch(e) {}


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
          
            const sdvxDiffs = ['NOV', 'ADV', 'EXH', 'MXM/INF/GRV/HVN/VVD'];
            sdvxStats.topPlays = top50.map((play: any) => {
              let songTitle = `Song ID ${play.mid}`;
              if (sdvxSongs?.mdb?.music) {
                const s = sdvxSongs.mdb.music.find((x: any) => String(x.id) === String(play.mid));
                if (s?.info?.title_name) songTitle = s.info.title_name;
              }
              if (sdvxCustomSongs?.mdb?.music) {
                const s = sdvxCustomSongs.mdb.music.find((x: any) => String(x.id) === String(play.mid));
                if (s?.info?.title_name) songTitle = s.info.title_name;
              }
              
              return {
                title: songTitle,
                diff: sdvxDiffs[play.type] || `Diff ${play.type}`,
                score: play.score,
                clear: play.clear,
                volforce: Number(play.volforce / 1000).toFixed(3),
                dateStr: timeAgo(play.updatedAt),
                jacketUrl: sdvxJacketUrl(play.mid, play.type)
              };
            });
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
            
            sdvxStats.recentPlays = recentRecs.map((play: any) => {
              let songTitle = `Song ID ${play.mid}`;
              if (sdvxSongs?.mdb?.music) {
                const s = sdvxSongs.mdb.music.find((x: any) => String(x.id) === String(play.mid));
                if (s?.info?.title_name) songTitle = s.info.title_name;
              }
              if (sdvxCustomSongs?.mdb?.music) {
                const s = sdvxCustomSongs.mdb.music.find((x: any) => String(x.id) === String(play.mid));
                if (s?.info?.title_name) songTitle = s.info.title_name;
              }

              return {
                title: songTitle,
                diff: sdvxDiffs[play.type] || `Diff ${play.type}`,
                score: play.score,
                clear: play.clear,
                dateStr: timeAgo(play.updatedAt),
                jacketUrl: sdvxJacketUrl(play.mid, play.type)
              };
            });
            
            // First Places
            const { getCachedResult } = require('./leaderboard');
            const cachedFirsts = getCachedResult('sdvx_firstPlaces') || [];
            const userFirsts = cachedFirsts.filter((f: any) => String(f.refid) === String(refid));
            sdvxStats.firstPlaces = userFirsts.map((f: any) => {
               const [mid, type] = f.key.split(':');
               let songTitle = `Song ID ${mid}`;
               if (sdvxSongs?.mdb?.music) {
                 const s = sdvxSongs.mdb.music.find((x: any) => String(x.id) === String(mid));
                 if (s?.info?.title_name) songTitle = s.info.title_name;
               }
               if (sdvxCustomSongs?.mdb?.music) {
                 const s = sdvxCustomSongs.mdb.music.find((x: any) => String(x.id) === String(mid));
                 if (s?.info?.title_name) songTitle = s.info.title_name;
               }

               return {
                  title: songTitle,
                  diff: sdvxDiffs[Number(type)] || `Diff ${type}`,
                  score: f.score,
                  clear: f.clear,
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
          iidxStats.totalScores = scores.length;
          
          const exScores = scores.filter((r: any) => (r.ex_score || 0) > 0);
          exScores.sort((a: any, b: any) => (b.ex_score || 0) - (a.ex_score || 0));
          const top50 = exScores.slice(0, 50);
          
            const iidxDiffs = ['SPB', 'SPN', 'SPH', 'SPA', 'SPL', 'DPN', 'DPH', 'DPA', 'DPL'];
            iidxStats.topPlays = top50.map((play: any) => {
               const mid = play.id || play.music_id || play.mid;
               let songTitle = `Song ID ${mid}`;
               if (iidxSongs && iidxSongs[String(mid)]?.title) {
                 songTitle = iidxSongs[String(mid)].title;
               }
               
               let diffIdx = play.style === 1 ? play.diff + 5 : play.diff;
               if (play.diff === undefined) diffIdx = -1;
               
               return {
                 title: songTitle,
                 diff: iidxDiffs[diffIdx] || `Diff ${play.diff}`,
                 score: play.ex_score,
                 clear: play.clear_flg !== undefined ? play.clear_flg : play.clear_type,
                 dateStr: timeAgo(play.updatedAt)
               };
            });
            // Trend
            const trendRecsIidx = [...scores].sort((a: any, b: any) => {
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
            const recentRecs = [...scores].sort((a: any, b: any) => {
               const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
               const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
               return tb - ta;
            }).slice(0, 5);
            
            iidxStats.recentPlays = recentRecs.map((play: any) => {
               const mid = play.id || play.music_id || play.mid;
               let songTitle = `Song ID ${mid}`;
               if (iidxSongs && iidxSongs[String(mid)]?.title) {
                 songTitle = iidxSongs[String(mid)].title;
               }
               
               let diffIdx = play.style === 1 ? play.diff + 5 : play.diff;
               if (play.diff === undefined) diffIdx = -1;
               return {
                 title: songTitle,
                 diff: iidxDiffs[diffIdx] || `Diff ${play.diff}`,
                 score: play.ex_score,
                 clear: play.clear_flg !== undefined ? play.clear_flg : play.clear_type,
                 dateStr: timeAgo(play.updatedAt)
               };
            });
            
            // First Places
            const { getCachedResult } = require('./leaderboard');
            const cachedFirsts = getCachedResult('iidx_firstPlaces') || [];
            const userFirsts = cachedFirsts.filter((f: any) => String(f.refid) === String(refid));
            iidxStats.firstPlaces = userFirsts.map((f: any) => {
               const [mid, style, diff] = f.key.split(':');
               let songTitle = `Song ID ${mid}`;
               if (iidxSongs && iidxSongs[String(mid)]?.title) {
                 songTitle = iidxSongs[String(mid)].title;
               }
               
               let diffIdx = Number(style) === 1 ? Number(diff) + 5 : Number(diff);
               if (diff === undefined) diffIdx = -1;
               return {
                  title: songTitle,
                  diff: iidxDiffs[diffIdx] || `Diff ${diff}`,
                  score: f.score,
                  clear: f.clear !== undefined ? f.clear : (f.clear_flg !== undefined ? f.clear_flg : f.clear_type)
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
    if (req.session.user && req.session.user.cardNumber) {
      const myCard = await FindCard(req.session.user.cardNumber);
      if (myCard && myCard.__refid) {
        myRefid = myCard.__refid;
        isFollowing = followers.includes(myRefid);
      }
    }

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
      })
    );
  })
);

profileRouter.post(
  '/profile/:refid',
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

    await UpdateProfile(refid, update);
    req.flash('formOk', 'Updated');
    res.redirect(req.originalUrl);
  })
);

profileRouter.post(
  '/profile/:refid/media',
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
