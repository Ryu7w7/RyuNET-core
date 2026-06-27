import { Router } from 'express';
import { json } from 'body-parser';
import { wrap } from '../shared/middleware';
import { userOwnsProfile } from '../shared/helpers';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { APIFind, APIFindOne, APIUpsert, APIUpdate, PLUGIN_PATH } from '../../utils/EamuseIO';

export const nablaRouter = Router();

nablaRouter.post(
  '/recalculate-vf',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid } = req.body;
    if (!refid) {
      return res.status(400).json({ success: false, description: 'Missing refid' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const musicDbPath = path.join(
      PLUGIN_PATH,
      'sdvx@asphyxia',
      'webui',
      'asset',
      'json',
      'music_db.json'
    );
    if (!existsSync(musicDbPath)) {
      return res
        .status(500)
        .json({ success: false, description: 'music_db.json not found in plugin folder' });
    }
    const mdb = JSON.parse(readFileSync(musicDbPath, 'utf8'));

    // Merge custom songs if file exists
    const customDbPath = path.join(
      PLUGIN_PATH,
      'sdvx@asphyxia',
      'webui',
      'asset',
      'json',
      'custom_music_db.json'
    );
    if (existsSync(customDbPath)) {
      try {
        const customDb = JSON.parse(readFileSync(customDbPath, 'utf8'));
        if (customDb?.mdb?.music?.length) {
          mdb.mdb.music = mdb.mdb.music.concat(customDb.mdb.music);
        }
      } catch {}
    }

    const medalCoef = [0, 0.5, 1.0, 1.02, 1.04, 1.06, 1.1];
    const gradeCoef = [0, 0.8, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.0, 1.02, 1.05];
    function computeForce(diff: number, score: number, medal: number, grade: number) {
      return Math.floor(diff * (score / 10000000) * gradeCoef[grade] * medalCoef[medal] * 20);
    }

    const diffName = ['novice', 'advanced', 'exhaust', 'infinite', 'maximum', 'ultimate'];
    const plugin = { identifier: 'sdvx@asphyxia', core: false };

    // Check if v7 profile exists; if not, migrate from v6
    let migrated = false;
    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    if (!v7Profile) {
      const v6Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 6 });
      if (!v6Profile) {
        return res
          .status(400)
          .json({ success: false, description: 'No Exceed Gear (v6) profile found to migrate' });
      }

      // Migrate profile
      await APIUpsert(
        plugin,
        refid,
        { collection: 'profile', version: 7 },
        {
          $set: {
            pluginVer: 1,
            dbver: 1,
            collection: 'profile',
            version: 7,
            id: v6Profile.id,
            name: v6Profile.name,
            appeal: 0,
            akaname: 0,
            blocks: 0,
            packets: 0,
            arsOption: 0,
            drawAdjust: 0,
            earlyLateDisp: 0,
            effCLeft: v6Profile.effCLeft,
            effCRight: v6Profile.effCRight,
            gaugeOption: 0,
            hiSpeed: v6Profile.hiSpeed,
            laneSpeed: v6Profile.laneSpeed,
            narrowDown: 0,
            notesOption: 0,
            blasterEnergy: 0,
            bgm: v6Profile.bgm,
            subbg: v6Profile.subbg,
            nemsys: 0,
            stampA: v6Profile.stampA,
            stampB: v6Profile.stampB,
            stampC: v6Profile.stampC,
            stampD: v6Profile.stampD,
            stampRA: v6Profile.stampRA,
            stampRB: v6Profile.stampRB,
            stampRC: v6Profile.stampRC,
            stampRD: v6Profile.stampRD,
            sysBG: 0,
            headphone: 0,
            musicID: 0,
            musicType: 0,
            sortType: 0,
            expPoint: 0,
            mUserCnt: 0,
            boothFrame: [0, 0, 0, 0, 0],
            playCount: 0,
            dayCount: 0,
            todayCount: 0,
            playchain: 0,
            maxPlayChain: 0,
            weekCount: 0,
            weekPlayCount: 0,
            weekChain: 0,
            maxWeekChain: 0,
            bplSupport: v6Profile.bplSupport,
            creatorItem: v6Profile.creatorItem,
          },
        }
      );

      // Migrate items
      const v6Items = await APIFind(plugin, refid, { collection: 'item', version: 6 });
      for (const item of v6Items) {
        await APIUpsert(
          plugin,
          refid,
          { collection: 'item', version: 7, type: item.type, id: item.id },
          {
            $set: { param: item.param },
          }
        );
      }

      // Migrate params
      const v6Params = await APIFind(plugin, refid, { collection: 'param', version: 6 });
      for (const param of v6Params) {
        const paramData = [...(param.param || [])];
        if (param.type === 2 && param.id === 1 && paramData.length > 24) paramData[24] = 0;
        await APIUpsert(
          plugin,
          refid,
          { collection: 'param', version: 7, type: param.type, id: param.id },
          {
            $set: { param: paramData },
          }
        );
      }

      // Migrate scores with clear lamp remapping and volforce computation
      const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];
      const exScoreResetList = [
        { id: 360, type: 3 },
        { id: 580, type: 2 },
        { id: 1121, type: 4 },
        { id: 1185, type: 2 },
        { id: 1199, type: 4 },
        { id: 1738, type: 4 },
        { id: 2242, type: 0 },
      ];
      const levelDifOverride = [
        { mid: 1, type: 1, lvl: 10 },
        { mid: 18, type: 1, lvl: 8 },
        { mid: 18, type: 2, lvl: 10 },
        { mid: 73, type: 2, lvl: 17 },
        { mid: 48, type: 1, lvl: 8 },
        { mid: 75, type: 2, lvl: 12 },
        { mid: 124, type: 2, lvl: 16 },
        { mid: 65, type: 1, lvl: 7 },
        { mid: 66, type: 1, lvl: 8 },
        { mid: 27, type: 1, lvl: 7 },
        { mid: 27, type: 2, lvl: 12 },
        { mid: 68, type: 1, lvl: 9 },
        { mid: 6, type: 1, lvl: 7 },
        { mid: 6, type: 2, lvl: 12 },
        { mid: 128, type: 2, lvl: 13 },
        { mid: 9, type: 2, lvl: 1 },
        { mid: 340, type: 2, lvl: 13 },
        { mid: 247, type: 3, lvl: 18 },
        { mid: 282, type: 2, lvl: 17 },
        { mid: 288, type: 2, lvl: 13 },
        { mid: 699, type: 3, lvl: 18 },
        { mid: 595, type: 2, lvl: 17 },
        { mid: 507, type: 2, lvl: 17 },
        { mid: 1044, type: 2, lvl: 16 },
        { mid: 948, type: 4, lvl: 16 },
        { mid: 1115, type: 4, lvl: 16 },
        { mid: 1215, type: 2, lvl: 15 },
        { mid: 1152, type: 2, lvl: 15 },
        { mid: 1282, type: 3, lvl: 17.5 },
        { mid: 1343, type: 2, lvl: 16 },
        { mid: 1300, type: 3, lvl: 17.5 },
        { mid: 1938, type: 2, lvl: 18 },
      ];

      const v6Scores = await APIFind(plugin, refid, { collection: 'music', version: 6 });
      for (const rec of v6Scores) {
        const song = mdb.mdb.music.find((s: any) => String(s.id) === String(rec.mid));
        if (!song) continue;

        let diffLevel = parseFloat(song.difficulty[diffName[rec.type]]) || 0;
        const lvOverride = levelDifOverride.find(d => d.mid === rec.mid && d.type === rec.type);
        if (lvOverride) diffLevel = lvOverride.lvl;

        const resetExScore = exScoreResetList.some(d => d.id === rec.mid && d.type === rec.type);
        const exscore = resetExScore ? 0 : rec.exscore || 0;
        const clear = nblClearLamp[rec.clear] ?? rec.clear;

        await APIUpsert(
          plugin,
          refid,
          { collection: 'music', mid: rec.mid, type: rec.type, version: 7 },
          {
            $set: {
              score: rec.score,
              exscore,
              clear,
              grade: rec.grade,
              volforce: computeForce(diffLevel, rec.score, clear, rec.grade),
              buttonRate: rec.buttonRate,
              longRate: rec.longRate,
              volRate: rec.volRate,
            },
          }
        );
      }

      migrated = true;
    }

    const scores = await APIFind(plugin, refid, { collection: 'music', version: 7 });

    let updated = 0;
    for (const score of scores) {
      const song = mdb.mdb.music.find((s: any) => String(s.id) === String(score.mid));
      if (!song) continue;

      const typeIndex = score.type;
      const key =
        typeIndex === 4
          ? song.difficulty.maximum || song.difficulty.infinite
          : song.difficulty[diffName[typeIndex]];
      const diffLevel = parseFloat(key) || 0;
      if (diffLevel === 0) continue;

      const newVf = computeForce(diffLevel, score.score, score.clear, score.grade);
      if (newVf !== score.volforce) {
        await APIUpdate(
          plugin,
          refid,
          { collection: 'music', mid: score.mid, type: score.type, version: 7 },
          { $set: { volforce: newVf } }
        );
        updated++;
      }
    }

    res.json({ success: true, total: scores.length, updated, migrated });
  })
);
