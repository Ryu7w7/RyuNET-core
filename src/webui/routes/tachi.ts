import { Router, json } from 'express';
import https from 'https';
import { CONFIG } from '../../utils/ArgConfig';
import {
  APIRemove,
  APIUpsert,
  APIFindOne,
  APIUpdate,
  APIInsert,
  APIFind,
  SaveTachiToken,
  GetTachiToken,
  GetTachiExportTimestamp,
  SaveTachiExportTimestamp,
  GetTachiAutoExport,
  SaveTachiAutoExport,
  DeleteTachiToken,
  FindCard,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';
import { userOwnsProfile } from '../shared/helpers';
import { Logger } from '../../utils/Logger';

export const tachiRouter = Router();
const TACHI_BASE_URL = 'https://kamai.tachi.ac';

// Tachi config endpoint 
tachiRouter.get('/config', (_req, res) => {
  res.json({ clientId: CONFIG.tachi_client_id || '' });
});

// Tachi OAuth callback
tachiRouter.get('/callback', (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing authorization code');
  res.send(`<html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'tachi-auth', code: '${code}' }, '*');
    }
    window.close();
  </script><p>Authorization complete. You can close this window.</p></body></html>`);
});

tachiRouter.post(
  '/exchange',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const code = req.body.code;
    if (!code) return res.status(400).json({ success: false, description: 'Missing code' });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/tachi/callback`;
    const postData = JSON.stringify({
      client_id: CONFIG.tachi_client_id,
      client_secret: CONFIG.tachi_client_secret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
    });

    const tokenResult: any = await new Promise((resolve, reject) => {
      const tokenReq = https.request(
        `${TACHI_BASE_URL}/api/v1/oauth/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (tokenRes: any) => {
          let body = '';
          tokenRes.on('data', (chunk: string) => (body += chunk));
          tokenRes.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Failed to parse Tachi response'));
            }
          });
        }
      );
      tokenReq.on('error', reject);
      tokenReq.write(postData);
      tokenReq.end();
    });

    if (!tokenResult.success || !tokenResult.body || !tokenResult.body.token) {
      return res.json({
        success: false,
        description: tokenResult.description || 'Token exchange failed',
      });
    }

    await SaveTachiToken(req.session.user!.username, tokenResult.body.token);
    res.json({ success: true });
  })
);

tachiRouter.get(
  '/status',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token) return res.json({ authorized: false });

    // Validate token
    const valid: boolean = await new Promise(resolve => {
      https
        .get(
          `${TACHI_BASE_URL}/api/v1/users/me`,
          { headers: { Authorization: `Bearer ${token}` } },
          (r: any) => {
            let body = '';
            r.on('data', (c: string) => (body += c));
            r.on('end', () => {
              try {
                const data = JSON.parse(body);
                resolve(data.success === true);
              } catch {
                resolve(false);
              }
            });
          }
        )
        .on('error', () => resolve(false));
    });

    if (!valid) {
      await DeleteTachiToken(req.session.user!.username);
      return res.json({ authorized: false });
    }

    res.json({ authorized: true });
  })
);

tachiRouter.post(
  '/disconnect',
  wrap(async (req, res) => {
    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        await SaveTachiAutoExport(card.__refid, false);
        const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: false };
        await APIRemove(sdvxPlugin, { collection: 'tachi_auto_export', refid: card.__refid });
      }
    }
    await DeleteTachiToken(req.session.user!.username);
    res.json({ success: true });
  })
);

tachiRouter.get(
  '/export-ts',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const timestamp = await GetTachiExportTimestamp(refid);
    res.json({ success: true, timestamp });
  })
);

tachiRouter.post(
  '/save-export-ts',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid } = req.body;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    await SaveTachiExportTimestamp(refid, Date.now());
    res.json({ success: true });
  })
);

tachiRouter.get(
  '/auto-export',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const enabled = await GetTachiAutoExport(refid);
    res.json({ success: true, enabled });
  })
);

tachiRouter.post(
  '/auto-export',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid, enabled } = req.body;
    if (!refid || typeof enabled !== 'boolean')
      return res.status(400).json({ success: false, description: 'Missing refid or enabled' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    await SaveTachiAutoExport(refid, enabled);

    const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: false };
    if (enabled) {
      const token = await GetTachiToken(req.session.user!.username);
      if (token) {
        await APIUpsert(
          sdvxPlugin,
          { collection: 'tachi_auto_export', refid },
          { collection: 'tachi_auto_export', refid, token }
        );
      }
    } else {
      await APIRemove(sdvxPlugin, { collection: 'tachi_auto_export', refid });
    }

    res.json({ success: true });
  })
);

tachiRouter.post(
  '/import',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token)
      return res.status(401).json({ success: false, description: 'Not authorized with Tachi' });

    const scores = req.body.scores;
    if (!scores || !Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({ success: false, description: 'No scores to import' });
    }

    const batchManual = JSON.stringify({
      meta: { game: 'sdvx', playtype: 'Single', service: 'Asphyxia' },
      scores,
    });

    const boundary = '----AsphyxiaTachi' + Date.now();
    const bodyParts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="importType"\r\n\r\n`,
      `file/batch-manual\r\n`,
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="scoreData"; filename="scores.json"\r\n`,
      `Content-Type: application/json\r\n\r\n`,
      batchManual + '\r\n',
      `--${boundary}--\r\n`,
    ];
    const postData = Buffer.from(bodyParts.join(''));

    const importResult: any = await new Promise((resolve, reject) => {
      const importReq = https.request(
        `${TACHI_BASE_URL}/api/v1/import/file`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': postData.length,
            'X-User-Intent': 'true',
          },
        },
        (importRes: any) => {
          let body = '';
          importRes.on('data', (chunk: string) => (body += chunk));
          importRes.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error('Failed to parse Tachi import response'));
            }
          });
        }
      );
      importReq.on('error', reject);
      importReq.write(postData);
      importReq.end();
    });

    res.json(importResult);
  })
);

tachiRouter.post(
  '/save-scores',
  json({ limit: '50mb' }),
  wrap(async (req, res) => {
    const { refid, scores } = req.body;
    if (!refid || !scores || !Array.isArray(scores)) {
      return res.status(400).json({ success: false, description: 'Missing refid or scores' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const plugin = { identifier: 'sdvx@asphyxia', core: false };
    let saved = 0;
    let skipped = 0;

    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    const targetVersion = v7Profile ? 7 : 6;
    const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];

    if (targetVersion === 7) {
      for (const score of scores) {
        if (!score.version || score.version === 6) {
          score.clear = nblClearLamp[score.clear] ?? score.clear;
          score.version = 7;
        }
      }
    }

    const NABLA_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    function clearRank(c: number) {
      return NABLA_CLEAR_RANK[c] ?? 0;
    }

    for (const score of scores) {
      try {
        const existing = await APIFind(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          version: targetVersion,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          if (
            score.score > ex.score ||
            clearRank(score.clear) > clearRank(ex.clear) ||
            (!ex.grade && score.grade)
          ) {
            const update: any = {};
            if (score.score > ex.score) update.score = score.score;
            if (clearRank(score.clear) > clearRank(ex.clear)) update.clear = score.clear;
            if (score.grade && (!ex.grade || score.grade > ex.grade)) update.grade = score.grade;
            if (score.exscore && (!ex.exscore || score.exscore > ex.exscore)) update.exscore = score.exscore;

            if (Object.keys(update).length > 0) {
              await APIUpdate(
                plugin,
                refid,
                { collection: 'music', mid: score.mid, type: score.type, version: targetVersion },
                { $set: update }
              );
              saved++;
            } else { skipped++; }
          } else { skipped++; }
          continue;
        }

        const doc: any = {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          score: score.score,
          clear: score.clear,
          exscore: score.exscore || 0,
          grade: score.grade || 0,
          buttonRate: 0,
          longRate: 0,
          volRate: 0,
          version: targetVersion,
          dbver: 1,
        };
        if (score.timeAchieved) {
          doc.createdAt = new Date(score.timeAchieved);
          doc.updatedAt = new Date(score.timeAchieved);
        }
        await APIInsert(plugin, refid, doc);
        saved++;
      } catch (err) {
        Logger.error(`Failed to save Tachi score mid=${score.mid} type=${score.type}: ${err}`);
      }
    }
    res.json({ success: true, saved, skipped });
  })
);

tachiRouter.get(
  '/pbs',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token) return res.status(401).json({ success: false, description: 'Not authorized' });

    const tachiGet = (urlPath: string): Promise<any> =>
      new Promise((resolve, reject) => {
        https
          .get(`${TACHI_BASE_URL}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } }, (r: any) => {
            let body = '';
            r.on('data', (c: string) => (body += c));
            r.on('end', () => {
              try { resolve(JSON.parse(body)); } catch { reject(new Error('Failed to parse Tachi response')); }
            });
          })
          .on('error', reject);
      });

    const result = await tachiGet('/api/v1/users/me/games/sdvx/Single/pbs/all');
    if (!result.success) return res.json({ success: false, description: result.description || 'Failed' });

    const { pbs, charts, songs } = result.body;
    const chartMap: Record<string, any> = {};
    for (const c of charts) chartMap[c.chartID] = c;
    const songMap: Record<number, any> = {};
    for (const s of songs) songMap[s.id] = s;

    const LAMP_TO_CLEAR: Record<string, number> = {
      'FAILED': 1, 'CLEAR': 2, 'EXCESSIVE CLEAR': 3, 'ULTIMATE CHAIN': 4,
      'PERFECT ULTIMATE CHAIN': 5, 'MAXXIVE CLEAR': 6,
    };
    const GRADE_MAP: Record<string, number> = {
      'D': 1, 'C': 2, 'B': 3, 'A': 4, 'A+': 5, 'AA': 6, 'AA+': 7, 'AAA': 8, 'AAA+': 9, 'S': 10, 'PUC': 10,
    };
    const DIFF_TO_TYPE: Record<string, number> = {
      NOV: 0, ADV: 1, EXH: 2, INF: 3, GRV: 3, HVN: 3, VVD: 3, XCD: 3, MXM: 4, ULT: 5,
    };

    const scores: any[] = [];
    for (const pb of pbs) {
      const chart = chartMap[pb.chartID];
      const song = songMap[pb.songID];
      if (!chart || !song) continue;

      const clear = LAMP_TO_CLEAR[pb.scoreData.lamp];
      const type = DIFF_TO_TYPE[chart.difficulty];
      if (clear === undefined || type === undefined) continue;

      scores.push({
        mid: chart.data.inGameID,
        type,
        score: pb.scoreData.score,
        clear,
        grade: GRADE_MAP[pb.scoreData.grade] || 0,
        exscore: pb.scoreData.optional?.exScore || 0,
        timeAchieved: pb.timeAchieved || null,
        songName: song.title,
        difficulty: chart.difficulty,
        lamp: pb.scoreData.lamp,
      });
    }
    res.json({ success: true, scores });
  })
);

tachiRouter.get(
  '/pbs/best',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token) return res.status(401).json({ success: false, description: 'Not authorized' });

    const tachiGet = (urlPath: string): Promise<any> =>
      new Promise((resolve, reject) => {
        https
          .get(`${TACHI_BASE_URL}${urlPath}`, { headers: { Authorization: `Bearer ${token}` } }, (r: any) => {
            let body = '';
            r.on('data', (c: string) => (body += c));
            r.on('end', () => {
              try { resolve(JSON.parse(body)); } catch { reject(new Error('Failed to parse Tachi response')); }
            });
          })
          .on('error', reject);
      });

    const result = await tachiGet('/api/v1/users/me/games/sdvx/Single/pbs/best');
    if (!result.success) return res.json({ success: false, description: result.description || 'Failed' });

    const { pbs, charts, songs } = result.body;
    const chartMap: Record<string, any> = {};
    for (const c of charts) chartMap[c.chartID] = c;
    const songMap: Record<number, any> = {};
    for (const s of songs) songMap[s.id] = s;

    const scores: any[] = [];
    for (const pb of pbs) {
      const chart = chartMap[pb.chartID];
      const song = chart ? songMap[chart.songID] : null;
      if (!chart || !song) continue;

      scores.push({
        score: pb.scoreData.score,
        lamp: pb.scoreData.lamp,
        grade: pb.scoreData.grade,
        songName: song.title,
        difficulty: chart.difficulty,
        level: chart.level,
        vf: pb.calculatedData?.VF6 || 0,
      });
    }
    res.json({ success: true, scores });
  })
);
