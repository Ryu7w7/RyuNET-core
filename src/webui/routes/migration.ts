import { Router, json } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import archiver from 'archiver';
const { serialize: nedbSerialize } = require('@seald-io/nedb/lib/model.js');
import {
  PLUGIN_PATH,
  APIFindOne,
  APIFind,
  APIUpsert,
  APIUpdate,
  APIInsert,
  FindProfile,
  FindCardsByRefid,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';
import { userOwnsProfile } from '../shared/helpers';
import { Logger } from '../../utils/Logger';

export const migrationRouter = Router();

// Nabla tools
migrationRouter.post(
  '/nabla/recalculate-vf',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid } = req.body;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const sdvxAssetPath = path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'json');
    const musicDbPath = path.join(sdvxAssetPath, 'music_db.json');
    if (!existsSync(musicDbPath)) {
      return res.status(500).json({ success: false, description: 'music_db.json not found' });
    }

    const mdb = JSON.parse(readFileSync(musicDbPath, 'utf8'));
    const customDbPath = path.join(sdvxAssetPath, 'custom_music_db.json');
    if (existsSync(customDbPath)) {
      try {
        const customDb = JSON.parse(readFileSync(customDbPath, 'utf8'));
        if (customDb?.mdb?.music) mdb.mdb.music = mdb.mdb.music.concat(customDb.mdb.music);
      } catch {}
    }

    const medalCoef = [0, 0.5, 1.0, 1.02, 1.04, 1.06, 1.1];
    const gradeCoef = [0, 0.8, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.0, 1.02, 1.05];
    const computeForce = (diff: number, score: number, medal: number, grade: number) => 
      Math.floor(diff * (score / 10000000) * gradeCoef[grade] * medalCoef[medal] * 20);

    const diffNames = ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate'];
    const plugin = { identifier: 'sdvx@asphyxia', core: false };

    // ... Migration Logic (Keep same as index.ts) ...
    // Note: I'm skipping the full migration logic here for brevity in the snippet, 
    // but in the actual file I would copy the logic from index.ts lines 1076-1288
    
    // (Actual implementation should include the migration logic from index.ts)
    // I will include the full logic to ensure it's functional.
    
    let migrated = false;
    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    if (!v7Profile) {
      const v6Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 6 });
      if (v6Profile) {
        await APIUpsert(plugin, refid, { collection: 'profile', version: 7 }, {
          $set: {
            pluginVer: 1, dbver: 1, collection: 'profile', version: 7,
            id: v6Profile.id, name: v6Profile.name, appeal: 0, akaname: 0,
            blocks: 0, packets: 0, arsOption: 0, drawAdjust: 0, earlyLateDisp: 0,
            effCLeft: v6Profile.effCLeft, effCRight: v6Profile.effCRight,
            gaugeOption: 0, hiSpeed: v6Profile.hiSpeed, laneSpeed: v6Profile.laneSpeed,
            narrowDown: 0, notesOption: 0, blasterEnergy: 0, bgm: v6Profile.bgm,
            subbg: v6Profile.subbg, nemsys: 0, stampA: v6Profile.stampA,
            stampB: v6Profile.stampB, stampC: v6Profile.stampC, stampD: v6Profile.stampD,
            stampRA: v6Profile.stampRA, stampRB: v6Profile.stampRB, stampRC: v6Profile.stampRC, stampRD: v6Profile.stampRD,
            sysBG: 0, headphone: 0, musicID: 0, musicType: 0, sortType: 0, expPoint: 0, mUserCnt: 0,
            boothFrame: [0, 0, 0, 0, 0], playCount: 0, dayCount: 0, todayCount: 0,
            playchain: 0, maxPlayChain: 0, weekCount: 0, weekPlayCount: 0, weekChain: 0, maxWeekChain: 0,
            bplSupport: v6Profile.bplSupport, creatorItem: v6Profile.creatorItem,
          }
        });

        const v6Items = await APIFind(plugin, refid, { collection: 'item', version: 6 });
        for (const i of v6Items) await APIUpsert(plugin, refid, { collection: 'item', version: 7, type: i.type, id: i.id }, { $set: { param: i.param } });

        const v6Params = await APIFind(plugin, refid, { collection: 'param', version: 6 });
        for (const p of v6Params) {
          const data = [...(p.param || [])];
          if (p.type === 2 && p.id === 1 && data.length > 24) data[24] = 0;
          await APIUpsert(plugin, refid, { collection: 'param', version: 7, type: p.type, id: p.id }, { $set: { param: data } });
        }

        const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];
        const v6Scores = await APIFind(plugin, refid, { collection: 'music', version: 6 });
        for (const rec of v6Scores) {
          const song = mdb.mdb.music.find((s: any) => String(s.id) === String(rec.mid));
          if (!song) continue;
          const diffLevel = parseFloat(song.difficulty[diffNames[rec.type]]) || 0;
          const clear = nblClearLamp[rec.clear] ?? rec.clear;
          await APIUpsert(plugin, refid, { collection: 'music', mid: rec.mid, type: rec.type, version: 7 }, {
            $set: {
              score: rec.score, exscore: rec.exscore || 0, clear, grade: rec.grade,
              volforce: computeForce(diffLevel, rec.score, clear, rec.grade),
              buttonRate: rec.buttonRate, longRate: rec.longRate, volRate: rec.volRate,
            }
          });
        }
        migrated = true;
      }
    }

    const scores = await APIFind(plugin, refid, { collection: 'music', version: 7 });
    let updated = 0;
    for (const score of scores) {
      const song = mdb.mdb.music.find((s: any) => String(s.id) === String(score.mid));
      if (!song) continue;
      const key = score.type === 4 ? song.difficulty.maximum || song.difficulty.infinite : song.difficulty[diffNames[score.type]];
      const diffLevel = parseFloat(key) || 0;
      if (diffLevel === 0) continue;
      const newVf = computeForce(diffLevel, score.score, score.clear, score.grade);
      if (newVf !== score.volforce) {
        await APIUpdate(plugin, refid, { collection: 'music', mid: score.mid, type: score.type, version: 7 }, { $set: { volforce: newVf } });
        updated++;
      }
    }
    res.json({ success: true, total: scores.length, updated, migrated });
  })
);

// Score migration
migrationRouter.post(
  '/migrate/import-scores',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const { refid, scores } = req.body;
    if (!refid || !scores || !Array.isArray(scores)) return res.status(400).json({ success: false });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const plugin = { identifier: 'sdvx@asphyxia', core: false };
    let saved = 0, skipped = 0;

    const rankMaps: any = { 6: { 0:0, 1:1, 2:2, 3:3, 6:4, 4:5, 5:6 }, 7: { 0:0, 1:1, 2:2, 3:3, 4:4, 5:5, 6:6 } };
    const getClearRank = (c: number, v: number) => (rankMaps[v] || rankMaps[6])[c] ?? 0;

    for (const s of scores) {
      try {
        const existing = await APIFind(plugin, refid, { collection: 'music', mid: s.mid, type: s.type, version: s.version || 6 });
        if (existing?.length > 0) {
          const ex = existing[0];
          const update: any = {};
          if (s.score > ex.score) {
            update.score = s.score;
            update.buttonRate = s.buttonRate || 0;
            update.longRate = s.longRate || 0;
            update.volRate = s.volRate || 0;
          }
          if (getClearRank(s.clear, s.version||6) > getClearRank(ex.clear, ex.version||6)) update.clear = s.clear;
          if (s.grade && (!ex.grade || s.grade > ex.grade)) update.grade = s.grade;
          if (s.exscore && (!ex.exscore || s.exscore > ex.exscore)) update.exscore = s.exscore;
          if (s.volforce && (!ex.volforce || s.volforce > ex.volforce)) update.volforce = s.volforce;

          if (Object.keys(update).length > 0) {
            await APIUpdate(plugin, refid, { collection: 'music', mid: s.mid, type: s.type, version: s.version || 6 }, { $set: update });
            saved++;
          } else skipped++;
        } else {
          await APIInsert(plugin, refid, {
            collection: 'music', mid: s.mid, type: s.type, score: s.score || 0, clear: s.clear || 0,
            exscore: s.exscore || 0, grade: s.grade || 0, buttonRate: s.buttonRate || 0,
            longRate: s.longRate || 0, volRate: s.volRate || 0, volforce: s.volforce || 0,
            version: s.version || 6, dbver: 1
          });
          saved++;
        }
      } catch (err) { Logger.error(err); }
    }
    res.json({ success: true, saved, skipped });
  })
);

migrationRouter.get(
  '/migrate/export-savedata',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) return res.status(400).json({ success: false });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const profile = await FindProfile(refid);
    if (!profile) return res.status(404).json({ success: false });
    const cards = await FindCardsByRefid(refid);

    const coreLines = [nedbSerialize(profile), ...(cards || []).map((c: any) => nedbSerialize(c))].join('\n') + '\n';
    const pluginDocs = await APIFind({ identifier: 'sdvx@asphyxia', core: true }, refid, {});
    const sdvxLines = (pluginDocs || []).map((d: any) => nedbSerialize(d)).join('\n') + '\n';

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => { if (!res.headersSent) res.status(500).json({ success: false }); });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="savedata.zip"');
    archive.pipe(res);
    archive.append(coreLines, { name: 'savedata/core.db' });
    archive.append(sdvxLines, { name: 'savedata/sdvx@asphyxia.db' });
    await archive.finalize();
  })
);
