import { Router, RequestHandler, Request } from 'express';
import { existsSync, readFileSync } from 'fs';
import session from 'express-session';
import cookies from 'cookie-parser';
import createMemoryStore from 'memorystore';
import flash from 'connect-flash';
import { VERSION } from '../utils/Consts';
import {
  CONFIG_MAP,
  CONFIG_DATA,
  CONFIG,
  CONFIG_OPTIONS,
  SaveConfig,
  ARGS,
  DATAFILE_MAP,
  FILE_CHECK,
} from '../utils/ArgConfig';
import { get, isEmpty } from 'lodash';
import { Converter } from 'showdown';
import {
  ReadAssets,
  PLUGIN_PATH,
  GetProfileCount,
  GetProfiles,
  FindCardsByRefid,
  Count,
  FindProfile,
  PurgeProfile,
  UpdateProfile,
  CreateCard,
  FindCard,
  DeleteCard,
  APIFind,
  APIRemove,
  PluginStats,
  PurgePlugin,
  APIFindOne,
  APIInsert,
  APIUpdate,
  APIUpsert,
  APICount,
  CreateUserAccount,
  AuthenticateUser,
  UpdateUserAccount,
  GetAllUsers,
  SetUserAdmin,
  FindUserByUsername,
  FindUserByCardNumber,
  SaveTachiToken,
  GetTachiToken,
  DeleteTachiToken,
  SaveTachiExportTimestamp,
  GetTachiExportTimestamp,
  SaveTachiAutoExport,
  GetTachiAutoExport,
} from '../utils/EamuseIO';
import { urlencoded, json } from 'body-parser';
import path from 'path';
import { ROOT_CONTAINER } from '../eamuse/index';
import { fun } from './fun';
import { card2nfc, nfc2card, cardType } from '../utils/CardCipher';
import { groupBy, startCase, lowerCase, upperFirst } from 'lodash';
import { sizeof } from 'sizeof';
import { ajax as emit } from './emit';
import { Logger } from '../utils/Logger';
import archiver from 'archiver';
const { serialize: nedbSerialize } = require('@seald-io/nedb/lib/model.js');

const memorystore = createMemoryStore(session);

const ADMIN_ONLY_PAGES = [
  'startup flags',
  'unlock events',
  'update webui assets',
  'weekly score attack',
];

declare module 'express-session' {
  interface SessionData {
    user?: { username: string; cardNumber: string; admin: boolean };
  }
}

export const webui = Router();
webui.use(
  session({
    cookie: { maxAge: 86400000, sameSite: true },
    secret: 'c0dedeadc0debeef',
    resave: true,
    saveUninitialized: false,
    store: new memorystore({ checkPeriod: 86400000 }),
  })
);
webui.use(cookies());

webui.use(flash());
webui.use(urlencoded({ extended: true, limit: '50mb' }));
let wrap =
  (fn: RequestHandler) =>
    (...args: any[]) =>
      (fn as any)(...args).catch(args[2]);

// Auth routes (accessible without login)
webui.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.admin ? '/' : '/about');
  res.render('login', { error: req.flash('authError')[0] || null });
});

webui.post(
  '/login',
  wrap(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      req.flash('authError', 'Please fill in all fields.');
      return res.redirect('/login');
    }

    const user = await AuthenticateUser(username, password);
    if (!user) {
      req.flash('authError', 'Invalid username or password.');
      return res.redirect('/login');
    }

    // Auto-update country if missing
    if (!user.countryCode || user.countryCode === 'xx') {
      try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (ip) {
          const http = require('http');
          const ipStr = typeof ip === 'string' ? ip.split(',')[0].trim() : ip[0];
          if (ipStr && ipStr !== '127.0.0.1' && ipStr !== '::1') {
            const newCountry = await new Promise<string | null>((resolve) => {
              const apiReq = http.get(`http://ip-api.com/json/${ipStr}?fields=countryCode`, (apiRes: any) => {
                let data = '';
                apiRes.on('data', (c: string) => data += c);
                apiRes.on('end', () => {
                  try {
                    const parsed = JSON.parse(data);
                    resolve(parsed.countryCode || null);
                  } catch {
                    resolve(null);
                  }
                });
              }).on('error', () => resolve(null));
              apiReq.setTimeout(2000, () => { apiReq.destroy(); resolve(null); });
            });
            if (newCountry) {
              await UpdateUserAccount(user.username, { countryCode: newCountry });
              user.countryCode = newCountry;
            }
          }
        }
      } catch {
        // ignore errors
      }
    }

    req.session.user = {
      username: user.username,
      cardNumber: user.cardNumber,
      admin: user.admin || false,
    };
    res.redirect(user.admin ? '/' : '/about');
  })
);

webui.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.admin ? '/' : '/about');
  res.render('signup', { error: req.flash('authError')[0] || null, old: {} });
});

webui.post(
  '/signup',
  wrap(async (req, res) => {
    const { username, password, confirmPassword, cardNumber } = req.body;
    const old = { username, cardNumber, password, confirmPassword };

    if (!username || !password || !confirmPassword || !cardNumber) {
      return res.render('signup', { error: 'Please fill in all fields.', old });
    }

    if (password !== confirmPassword) {
      return res.render('signup', { error: 'Passwords do not match.', old });
    }

    if (username.length < 3) {
      return res.render('signup', { error: 'Username must be at least 3 characters.', old });
    }

    if (password.length < 4) {
      return res.render('signup', { error: 'Password must be at least 4 characters.', old });
    }

    // Normalize: strip spaces/dashes, uppercase
    const normalized = cardNumber.replace(/[\s\-]/g, '').toUpperCase();

    // Determine NFC ID: Use the hex directly as the unique NFC identifier, 
    // strictly ignoring any printed Card Number format
    let nfcId: string;
    if (/^[0-9A-F]{16}$/.test(normalized)) {
      nfcId = normalized;
    } else {
      return res.render('signup', {
        error: 'Invalid card number format. Must be a 16-character hex string.',
        old,
      });
    }

    const card = await FindCard(nfcId);
    if (!card) {
      return res.render('signup', {
        error: 'Card number not found. You must have a registered card to sign up.',
        old,
      });
    }

    // Check if this card (or any other card on the same profile) is already owned by a user account
    if (card.__refid) {
      const profileCards = await FindCardsByRefid(card.__refid);
      if (profileCards && Array.isArray(profileCards)) {
        for (const c of profileCards) {
          const owner = await FindUserByCardNumber(c.cid);
          if (owner) {
            return res.render('signup', {
              error: 'This card number is already registered to an account.',
              old,
            });
          }
        }
      }
    } else {
      const existingAccount = await FindUserByCardNumber(nfcId);
      if (existingAccount) {
        return res.render('signup', {
          error: 'This card number is already registered to an account.',
          old,
        });
      }
    }

    let countryCode = null;
    try {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      if (ip) {
        const http = require('http');
        const ipStr = typeof ip === 'string' ? ip.split(',')[0].trim() : ip[0];
        // don't try to lookup local IPs on the API
        if (ipStr && ipStr !== '127.0.0.1' && ipStr !== '::1') {
          countryCode = await new Promise<string | null>((resolve) => {
            const apiReq = http.get(`http://ip-api.com/json/${ipStr}?fields=countryCode`, (apiRes: any) => {
              let data = '';
              apiRes.on('data', (c: string) => data += c);
              apiRes.on('end', () => {
                try {
                  const parsed = JSON.parse(data);
                  resolve(parsed.countryCode || null);
                } catch {
                  resolve(null);
                }
              });
            }).on('error', () => resolve(null));
            apiReq.setTimeout(2000, () => { apiReq.destroy(); resolve(null); });
          });
        }
      }
    } catch {
      // ignore errors
    }

    const account = await CreateUserAccount(username, password, nfcId, false, countryCode);
    if (!account) {
      return res.render('signup', { error: 'Username already exists.', old });
    }

    // Update the profile name to match the signup username
    if (card.__refid) {
      await UpdateProfile(card.__refid, { name: username });
    }

    req.session.user = { username, cardNumber: nfcId, admin: false };
    res.redirect('/about');
  })
);

webui.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Help pages (accessible without login)
webui.get('/help/card-number', (_req, res) => {
  res.render('help_card_number');
});

// Tachi config endpoint (before auth middleware - needed by client-side JS)
webui.get('/tachi/config', (_req, res) => {
  res.json({ clientId: CONFIG.tachi_client_id || '' });
});

// Tachi OAuth callback (before auth middleware - opened in popup without session)
webui.get('/tachi/callback', (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing authorization code');
  res.send(`<html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'tachi-auth', code: '${code}' }, '*');
    }
    window.close();
  </script><p>Authorization complete. You can close this window.</p></body></html>`);
});

// Auth middleware - all routes below require login
webui.use((req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
});



// Account settings
webui.get(
  '/account',
  wrap(async (req, res) => {
    res.render('account', data(req, 'Account', 'core'));
  })
);

webui.post(
  '/account',
  wrap(async (req, res) => {
    const { username, password, confirmPassword } = req.body;
    const currentUsername = req.session.user!.username;

    if (password && password !== confirmPassword) {
      req.flash('formWarn', 'Passwords do not match.');
      return res.redirect('/account');
    }

    if (password && password.length < 4) {
      req.flash('formWarn', 'Password must be at least 4 characters.');
      return res.redirect('/account');
    }

    const updateFields: { username?: string; password?: string } = {};

    if (username && username !== currentUsername) {
      if (username.length < 3) {
        req.flash('formWarn', 'Username must be at least 3 characters.');
        return res.redirect('/account');
      }
      const existing = await FindUserByUsername(username);
      if (existing) {
        req.flash('formWarn', 'Username already taken.');
        return res.redirect('/account');
      }
      updateFields.username = username;
    }

    if (password) {
      updateFields.password = password;
    }

    if (Object.keys(updateFields).length > 0) {
      await UpdateUserAccount(currentUsername, updateFields);
      if (updateFields.username) {
        req.session.user!.username = updateFields.username;
      }
      req.flash('formOk', 'Account updated.');
    }

    res.redirect('/account');
  })
);

webui.get(
  '/admin/account/:username',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.redirect('/');
    const targetUser = await FindUserByUsername(req.params.username);
    if (!targetUser) return res.redirect('/profiles');
    res.render('admin_account', data(req, 'Edit User Credentials', 'core', { targetUser }));
  })
);

webui.post(
  '/admin/account/:username',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.redirect('/');
    const targetUser = await FindUserByUsername(req.params.username);
    if (!targetUser) return res.redirect('/profiles');
    
    const { username, password, countryCode } = req.body;
    
    if (password && password.length < 4) {
      req.flash('formWarn', 'Password must be at least 4 characters.');
      return res.redirect(`/admin/account/${req.params.username}`);
    }

    const updateFields: { username?: string; password?: string; countryCode?: string | null } = {};

    if (username && username !== targetUser.username) {
      if (username.length < 3) {
        req.flash('formWarn', 'Username must be at least 3 characters.');
        return res.redirect(`/admin/account/${req.params.username}`);
      }
      const existing = await FindUserByUsername(username);
      if (existing) {
        req.flash('formWarn', 'Username already taken.');
        return res.redirect(`/admin/account/${req.params.username}`);
      }
      updateFields.username = username;
    }

    if (password) {
      updateFields.password = password;
    }

    if (Object.keys(req.body).includes('countryCode')) {
      const parsedCountry = countryCode ? String(countryCode).toUpperCase().trim() : null;
      if (parsedCountry !== targetUser.countryCode) {
        updateFields.countryCode = parsedCountry || null;
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await UpdateUserAccount(targetUser.username, updateFields);
      req.flash('formOk', 'User credentials updated successfully.');
    }
    
    res.redirect(`/admin/account/${updateFields.username || targetUser.username}`);
  })
);

// User management (admin only)
webui.get(
  '/users',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.redirect('/');
    const users = await GetAllUsers();
    res.render('users', data(req, 'Users', 'core', { users }));
  })
);

webui.post(
  '/users/toggle-admin',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.sendStatus(403);
    const { username } = req.body;
    if (username === req.session.user!.username) return res.redirect('/users');

    const target = await FindUserByUsername(username);
    if (target) {
      await SetUserAdmin(username, !target.admin);
    }
    res.redirect('/users');
  })
);

// Tachi API endpoints
const TACHI_BASE_URL = 'https://kamai.tachi.ac';

webui.post(
  '/tachi/exchange',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const code = req.body.code;
    if (!code) return res.status(400).json({ success: false, description: 'Missing code' });

    const https = require('https');
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
webui.get(
  '/tachi/status',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token) return res.json({ authorized: false });

    // Validate token against Tachi
    const https = require('https');
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

webui.post(
  '/tachi/disconnect',
  wrap(async (req, res) => {
    // Clean up auto-export entries for this user's profiles
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

webui.get(
  '/tachi/export-ts',
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

webui.post(
  '/tachi/save-export-ts',
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

webui.get(
  '/tachi/auto-export',
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

webui.post(
  '/tachi/auto-export',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid, enabled } = req.body;
    if (!refid || typeof enabled !== 'boolean')
      return res.status(400).json({ success: false, description: 'Missing refid or enabled' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    await SaveTachiAutoExport(refid, enabled);

    // Store/clear a copy of the Tachi token in the plugin DB so the saveScore
    // handler can access it without needing CoreDB
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

webui.post(
  '/tachi/import',
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
      meta: {
        game: 'sdvx',
        playtype: 'Single',
        service: 'Asphyxia',
      },
      scores,
    });

    const https = require('https');

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

webui.post(
  '/tachi/save-scores',
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

    // Detect if user has a v7 (Nabla) profile to determine target version
    const v7Profile = await APIFindOne(plugin, refid, { collection: 'profile', version: 7 });
    const targetVersion = v7Profile ? 7 : 6;

    // v6→v7 clear type remapping (UC/PUC/MXV positions differ between versions)
    // EG (v6): 0=none, 1=played, 2=clear, 3=excessive, 4=uc, 5=puc, 6=mxv
    // Nabla (v7): 0=none, 1=played, 2=clear, 3=excessive, 4=mxv, 5=uc, 6=puc
    const nblClearLamp = [0, 1, 2, 3, 5, 6, 4];

    // Convert incoming v6 clear types to v7 format for Nabla users
    if (targetVersion === 7) {
      for (const score of scores) {
        if (!score.version || score.version === 6) {
          score.clear = nblClearLamp[score.clear] ?? score.clear;
          score.version = 7;
        }
      }
    }

    // Normalize clear values to a comparable ranking
    const NABLA_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    function clearRank(c: number) {
      return NABLA_CLEAR_RANK[c] ?? 0;
    }

    for (const score of scores) {
      try {
        // Check if score already exists for this refid (filter by target version)
        const existing = await APIFind(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          version: targetVersion,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          // Update if incoming score is higher, or clear is better, or existing has missing grade
          if (
            score.score > ex.score ||
            clearRank(score.clear) > clearRank(ex.clear) ||
            (!ex.grade && score.grade)
          ) {
            const update: any = {};
            if (score.score > ex.score) update.score = score.score;
            if (clearRank(score.clear) > clearRank(ex.clear))
              update.clear = score.clear;
            if (score.grade && (!ex.grade || score.grade > ex.grade)) update.grade = score.grade;
            if (score.exscore && (!ex.exscore || score.exscore > ex.exscore))
              update.exscore = score.exscore;

            if (Object.keys(update).length > 0) {
              await APIUpdate(
                plugin,
                refid,
                { collection: 'music', mid: score.mid, type: score.type, version: targetVersion },
                { $set: update }
              );
              saved++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
          continue;
        }

        // Insert new scores
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

webui.get(
  '/tachi/pbs',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token)
      return res.status(401).json({ success: false, description: 'Not authorized with Tachi' });

    const https = require('https');

    const tachiGet = (urlPath: string): Promise<any> =>
      new Promise((resolve, reject) => {
        https
          .get(
            `${TACHI_BASE_URL}${urlPath}`,
            { headers: { Authorization: `Bearer ${token}` } },
            (r: any) => {
              let body = '';
              r.on('data', (c: string) => (body += c));
              r.on('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  reject(new Error('Failed to parse Tachi response'));
                }
              });
            }
          )
          .on('error', reject);
      });

    const result = await tachiGet('/api/v1/users/me/games/sdvx/Single/pbs/all');
    if (!result.success) {
      return res.json({ success: false, description: result.description || 'Failed to fetch PBs' });
    }

    const { pbs, charts, songs } = result.body;

    const chartMap: Record<string, any> = {};
    for (const c of charts) chartMap[c.chartID] = c;

    const songMap: Record<number, any> = {};
    for (const s of songs) songMap[s.id] = s;

    // Tachi lamp to SDVX EG clear type mapping (reverse of export)
    // EG: 0=none, 1=played, 2=clear, 3=excessive, 4=uc, 5=puc, 6=mxv
    const LAMP_TO_CLEAR: Record<string, number> = {
      'FAILED': 1,
      'CLEAR': 2,
      'EXCESSIVE CLEAR': 3,
      'ULTIMATE CHAIN': 4,
      'PERFECT ULTIMATE CHAIN': 5,
      'MAXXIVE CLEAR': 6,
    };

    // Tachi grade to Asphyxia grade mapping
    const GRADE_MAP: Record<string, number> = {
      'D': 1,
      'C': 2,
      'B': 3,
      'A': 4,
      'A+': 5,
      'AA': 6,
      'AA+': 7,
      'AAA': 8,
      'AAA+': 9,
      'S': 10,
      'PUC': 10,
    };

    // Tachi difficulty to SDVX type mapping
    const DIFF_TO_TYPE: Record<string, number> = {
      NOV: 0,
      ADV: 1,
      EXH: 2,
      INF: 3,
      GRV: 3,
      HVN: 3,
      VVD: 3,
      XCD: 3,
      MXM: 4,
      ULT: 5,
    };

    const scores: any[] = [];
    for (let i = 0; i < pbs.length; i++) {
      const pb = pbs[i];
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

webui.get(
  '/tachi/pbs/best',
  wrap(async (req, res) => {
    const token = await GetTachiToken(req.session.user!.username);
    if (!token)
      return res.status(401).json({ success: false, description: 'Not authorized with Tachi' });

    const https = require('https');

    const tachiGet = (urlPath: string): Promise<any> =>
      new Promise((resolve, reject) => {
        https
          .get(
            `${TACHI_BASE_URL}${urlPath}`,
            { headers: { Authorization: `Bearer ${token}` } },
            (r: any) => {
              let body = '';
              r.on('data', (c: string) => (body += c));
              r.on('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch {
                  reject(new Error('Failed to parse Tachi response'));
                }
              });
            }
          )
          .on('error', reject);
      });

    const result = await tachiGet('/api/v1/users/me/games/sdvx/Single/pbs/best');
    if (!result.success) {
      return res.json({ success: false, description: result.description || 'Failed to fetch PBs' });
    }

    const { pbs, charts, songs } = result.body;

    const chartMap: Record<string, any> = {};
    for (const c of charts) chartMap[c.chartID] = c;

    const songMap: Record<number, any> = {};
    for (const s of songs) songMap[s.id] = s;

    const scores: any[] = [];
    for (let i = 0; i < pbs.length; i++) {
      const pb = pbs[i];
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

// Nabla tools
webui.post(
  '/nabla/recalculate-vf',
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
      } catch { }
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
        { mid: 16, type: 1, lvl: 7 },
        { mid: 2, type: 1, lvl: 10 },
        { mid: 60, type: 3, lvl: 17 },
        { mid: 5, type: 2, lvl: 13 },
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

// Score migration from another Asphyxia server
webui.post(
  '/migrate/import-scores',
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

    const EG_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 6: 4, 4: 5, 5: 6 };
    const NABLA_CLEAR_RANK: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    function clearRank(c: number, version?: number) {
      const map = version === 7 ? NABLA_CLEAR_RANK : EG_CLEAR_RANK;
      return map[c] ?? 0;
    }

    for (const score of scores) {
      try {
        const existing = await APIFind(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          version: score.version || 6,
        });

        if (existing && existing.length > 0) {
          const ex = existing[0];
          const update: any = {};
          if (score.score > ex.score) {
            update.score = score.score;
            update.buttonRate = score.buttonRate || 0;
            update.longRate = score.longRate || 0;
            update.volRate = score.volRate || 0;
          }
          if (clearRank(score.clear, score.version) > clearRank(ex.clear, ex.version))
            update.clear = score.clear;
          if (score.grade && (!ex.grade || score.grade > ex.grade)) update.grade = score.grade;
          if (score.exscore && (!ex.exscore || score.exscore > ex.exscore))
            update.exscore = score.exscore;
          if (score.volforce && (!ex.volforce || score.volforce > ex.volforce))
            update.volforce = score.volforce;

          if (Object.keys(update).length > 0) {
            await APIUpdate(
              plugin,
              refid,
              {
                collection: 'music',
                mid: score.mid,
                type: score.type,
                version: score.version || 6,
              },
              { $set: update }
            );
            saved++;
          } else {
            skipped++;
          }
          continue;
        }

        await APIInsert(plugin, refid, {
          collection: 'music',
          mid: score.mid,
          type: score.type,
          score: score.score || 0,
          clear: score.clear || 0,
          exscore: score.exscore || 0,
          grade: score.grade || 0,
          buttonRate: score.buttonRate || 0,
          longRate: score.longRate || 0,
          volRate: score.volRate || 0,
          volforce: score.volforce || 0,
          version: score.version || 6,
          dbver: 1,
        });
        saved++;
      } catch (err) {
        Logger.error(`Failed to migrate score mid=${score.mid} type=${score.type}: ${err}`);
      }
    }

    res.json({ success: true, saved, skipped });
  })
);

// Export savedata for migration to another Asphyxia server
webui.get(
  '/migrate/export-savedata',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) {
      return res.status(400).json({ success: false, description: 'Missing refid' });
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    // Gather core.db documents (profile + cards)
    const profile = await FindProfile(refid);
    if (!profile) {
      return res.status(404).json({ success: false, description: 'Profile not found' });
    }
    const cards = await FindCardsByRefid(refid);

    // Gather sdvx@asphyxia.db documents (all plugin data for this refid)
    // core: true preserves __s, __refid, _id, createdAt, updatedAt fields
    const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: true };
    const pluginDocs = await APIFind(sdvxPlugin, refid, {});

    // Format as NeDB (one JSON per line, using NeDB's serialize for correct Date handling)
    const coreLines: string[] = [];
    coreLines.push(nedbSerialize(profile));
    if (cards && Array.isArray(cards)) {
      for (const card of cards) {
        coreLines.push(nedbSerialize(card));
      }
    }
    const coreContent = coreLines.join('\n') + '\n';

    const sdvxLines: string[] = [];
    if (pluginDocs && Array.isArray(pluginDocs)) {
      for (const doc of pluginDocs) {
        sdvxLines.push(nedbSerialize(doc));
      }
    }
    const sdvxContent = sdvxLines.join('\n') + '\n';

    // Create zip with maximum compression
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err: Error) => {
      Logger.error(`Export zip generation failed: ${err}`);
      if (!res.headersSent) {
        res.status(500).json({ success: false, description: 'Zip generation failed' });
      }
    });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="savedata.zip"');

    archive.pipe(res);
    archive.append(coreContent, { name: 'savedata/core.db' });
    archive.append(sdvxContent, { name: 'savedata/sdvx@asphyxia.db' });
    await archive.finalize();
  })
);

webui.use('/fun', fun);
webui.use('/', emit);

const markdown = new Converter({
  headerLevelStart: 3,
  strikethrough: true,
  tables: true,
  tasklists: true,
});

async function userOwnsProfile(req: Request, refid: string): Promise<boolean> {
  if (!req.session.user) return false;
  const cardNumber = req.session.user.cardNumber;
  if (!cardNumber) return false;
  const cards = await FindCardsByRefid(refid);
  if (!cards || !Array.isArray(cards)) return false;
  return cards.some((c: any) => c.cid === cardNumber || c.print === cardNumber);
}

function data(req: Request, title: string, plugin: string, attr?: any) {
  const formOk = req.flash('formOk');
  const formWarn = req.flash('formWarn');
  const aside = req.cookies.asidemenu == 'true';

  let formMessage = null;
  if (formOk.length > 0) {
    formMessage = { danger: false, message: formOk.join(' ') };
  } else if (formWarn.length > 0) {
    formMessage = { danger: true, message: formWarn.join(' ') };
  }

  return {
    title,
    aside,
    plugin,
    local: req.ip == '127.0.0.1' || req.ip == '::1',
    version: VERSION,
    user: req.session.user ? req.session.user.username : null,
    admin: req.session.user ? req.session.user.admin : false,
    formMessage,
    plugins: ROOT_CONTAINER.Plugins.map(p => {
      return {
        name: p.Name,
        id: p.Identifier,
        webOnly: p.GameCodes.length == 0,
        pages: p.Pages.filter(f => req.session.user?.admin || !ADMIN_ONLY_PAGES.includes(f)).map(
          f => ({ name: startCase(f), link: f })
        ),
      };
    }),
    ...attr,
  };
}

function validate(c: CONFIG_OPTIONS, current: any) {
  if (c.validator) {
    const msg = c.validator(current);
    if (typeof msg == 'string') {
      return msg.length == 0 ? 'Invalid value' : msg;
    }
  }

  if (c.range) {
    if (c.type == 'float' || c.type == 'integer') {
      if (current < c.range[0] || current > c.range[1]) {
        return `Value must be in between ${c.range[0]} and ${c.range[1]}.`;
      }
    }
  }

  if (c.options) {
    if (c.type == 'string') {
      if (c.options.indexOf(current) < 0) {
        return `Please select an option.`;
      }
    }
  }

  return null;
}

function ConfigData(plugin: string) {
  const config: CONFIG_DATA[] = [];
  const configMap = CONFIG_MAP[plugin];
  const configData = plugin == 'core' ? CONFIG : CONFIG[plugin];

  if (!configMap || !configData) {
    return [];
  }

  if (configMap) {
    for (const [key, c] of configMap) {
      const name = get(c, 'name', upperFirst(lowerCase(key)));
      const current = get(configData, key, c.default);
      let error = validate(c, current);

      config.push({
        key,
        ...c,
        current,
        name,
        error,
      });
    }
  }
  return config;
}

function DataFileCheck(plugin: string) {
  const files: FILE_CHECK[] = [];
  const fileMap = DATAFILE_MAP[plugin];

  if (!fileMap) {
    return [];
  }

  for (const [filepath, c] of fileMap) {
    const target = path.resolve(PLUGIN_PATH, plugin, filepath);
    const filename = path.basename(target);
    const uploaded = existsSync(target);
    const config = { ...c };
    if (!c.name) {
      config.name = filename;
    }
    files.push({ ...config, path: filepath, uploaded, filename });
  }

  return files;
}

webui.get('/favicon.ico', async (req, res) => {
  res.redirect('/static/favicon.ico');
});

webui.get(
  '/',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.redirect('/about');
    const memory = `${(process.memoryUsage().rss / 1048576).toFixed(2)}MB`;
    const config = ConfigData('core');

    const changelog = markdown.makeHtml(ReadAssets('changelog.md'));

    const profiles = await GetProfileCount();
    res.render('index', data(req, 'Dashboard', 'core', { memory, config, changelog, profiles }));
  })
);

webui.get(
  '/my-profile',
  wrap(async (req, res) => {
    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        return res.redirect(`/profile/${card.__refid}`);
      }
    }
    return res.redirect('/');
  })
);


webui.get(
  '/profiles',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.redirect('/');
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


webui.delete(
  '/profile/:refid',
  wrap(async (req, res) => {
    if (!req.session.user!.admin) return res.sendStatus(403);
    const refid = req.params['refid'];

    if (await PurgeProfile(refid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

webui.get(
  '/profile/:refid',
  wrap(async (req, res, next) => {
    const refid = req.params['refid'];

    const profile = await FindProfile(refid);
    if (!profile) {
      return next();
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.redirect('/');

    let countryCode = 'xx';
    profile.cards = await FindCardsByRefid(refid);
    if (profile.cards && profile.cards.length > 0) {
      for (const c of profile.cards) {
        const u = await FindUserByCardNumber(c.cid);
        if (u && u.countryCode) {
          countryCode = u.countryCode.toLowerCase();
          break;
        }
      }
    }

    res.render(
      'profiles_profile',
      data(req, 'Profiles', 'core', { profile, subtitle: profile.name, isAdmin, isOwner, countryCode })
    );
  })
);

webui.delete(
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

    if (!isAdmin && !isOwner) {
      return res.sendStatus(403);
    }

    if (await DeleteCard(cid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

webui.post(
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
      const cid = normalized;
      const print = normalized;

      if (!(await FindCard(cid))) {
        await CreateCard(cid, refid, print);
      }
    }

    res.sendStatus(200);
  })
);

webui.post(
  '/profile/:refid',
  urlencoded({ extended: true, limit: '50mb' }),
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (!req.session.user!.admin && !(await userOwnsProfile(req, refid)))
      return res.sendStatus(403);
    const update: any = {};
    if (req.body.pin) {
      update.pin = req.body.pin;
    }
    if (req.body.name) {
      update.name = req.body.name;
    }
    if (req.body.paseli !== undefined && req.body.paseli !== '') {
      let paseli = parseInt(String(req.body.paseli), 10);
      if (!isNaN(paseli)) {
        if (paseli < 0) paseli = 0;
        if (paseli > 100000) paseli = 100000;
        update.paseli = paseli;
      }
    }

    await UpdateProfile(refid, update);
    req.flash('formOk', 'Updated');
    res.redirect(req.originalUrl);
  })
);

// Data Management
webui.get(
  '/data',
  wrap(async (req, res) => {
    if (!req.session.user?.admin) {
      return res.redirect('/');
    }
    const pluginStats = await PluginStats();
    const installed = ROOT_CONTAINER.Plugins.map(p => p.Identifier);
    res.render(
      'data',
      data(req, 'Data Management', 'core', { pluginStats, installed, dev: ARGS.dev })
    );
  })
);

webui.get(
  '/data/:plugin',
  wrap(async (req, res, next) => {
    if (!ARGS.dev) {
      next();
      return;
    }
    const pluginID = req.params['plugin'];

    res.render('data_plugin', data(req, 'Data Management', 'core', { subtitle: pluginID }));
  })
);

webui.post(
  '/data/db',
  json({ limit: '50mb' }),
  wrap(async (req, res, next) => {
    if (!ARGS.dev) {
      next();
      return;
    }
    const command = req.body.command;
    const args = req.body.args;
    const plugin = req.body.plugin;

    try {
      switch (command) {
        case 'FindOne':
          res.json(await (APIFindOne as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Find':
          res.json(await (APIFind as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Insert':
          res.json(await (APIInsert as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Remove':
          res.json(await (APIRemove as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Update':
          res.json(await (APIUpdate as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Upsert':
          res.json(await (APIUpsert as any)({ identifier: plugin, core: false }, ...args));
          break;
        case 'Count':
          res.json(await (APICount as any)({ identifier: plugin, core: false }, ...args));
          break;
      }
    } catch (err) {
      res.json({ error: err.toString() });
    }
  })
);

webui.delete(
  '/data/:plugin',
  wrap(async (req, res) => {
    const pluginID = req.params['plugin'];
    if (pluginID && pluginID.length > 0) await PurgePlugin(pluginID);

    const plugin = ROOT_CONTAINER.getPluginByID(pluginID);
    if (plugin) {
      // Re-register for init data
      try {
        plugin.Register();
      } catch (err) {
        Logger.error(err, { plugin: pluginID });
      }
    }
    res.sendStatus(200);
  })
);

webui.get(
  '/about',
  wrap(async (req, res) => {
    const contributors = new Map<string, { name: string; link?: string }>();
    for (const plugin of ROOT_CONTAINER.Plugins) {
      for (const c of plugin.Contributors) {
        contributors.set(c.name, c);
      }
    }
    res.render(
      'about',
      data(req, 'About', 'core', { contributors: Array.from(contributors.values()) })
    );
  })
);

// Plugin Overview
webui.get(
  '/plugin/:plugin',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const readmePath = path.join(PLUGIN_PATH, plugin.Identifier, 'README.md');
    let readme = null;
    try {
      if (existsSync(readmePath)) {
        readme = markdown.makeHtml(readFileSync(readmePath, { encoding: 'utf-8' }));
      }
    } catch {
      readme = null;
    }

    const config = ConfigData(plugin.Identifier);
    const datafile = DataFileCheck(plugin.Identifier);
    const contributors = plugin ? plugin.Contributors : [];
    const gameCodes = plugin ? plugin.GameCodes : [];

    res.render(
      'plugin',
      data(req, plugin.Name, plugin.Identifier, {
        readme,
        config,
        datafile,
        contributors,
        gameCodes,
        subtitle: 'Overview',
        subidentifier: 'overview',
      })
    );
  })
);

webui.delete(
  '/plugin/:plugin/profile/:refid',
  wrap(async (req, res) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return res.sendStatus(404);
    }

    const refid = req.params['refid'];
    if (!refid || refid.length < 0) {
      return res.sendStatus(400);
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    if (await APIRemove({ identifier: plugin.Identifier, core: true }, refid, {})) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

// Plugin statics
webui.get(
  '/plugin/:plugin/static/*',
  wrap(async (req, res, next) => {
    const data = req.params[0];

    if (data.startsWith('.')) {
      return next();
    }

    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const file = path.join(PLUGIN_PATH, plugin.Identifier, 'webui', data);

    res.sendFile(file, {}, err => {
      if (err) {
        next();
      }
    });
  })
);

// Plugin My Profile (redirect to own profile)
webui.get(
  '/plugin/:plugin/my-profile',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);
    if (!plugin) return next();

    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        return res.redirect(`/plugin/${req.params['plugin']}/profile?refid=${card.__refid}`);
      }
    }
    return res.redirect(`/plugin/${req.params['plugin']}`);
  })
);

// Plugin Profiles
webui.get(
  '/plugin/:plugin/profiles',
  wrap(async (req, res, next) => {
    if (!req.session.user!.admin) return res.redirect('/');

    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const profiles = groupBy(
      await APIFind({ identifier: plugin.Identifier, core: true }, null, {}),
      '__refid'
    );

    const profileData: any[] = [];
    for (const refid in profiles) {
      let name = undefined;
      for (const doc of profiles[refid]) {
        if (doc.__refid == null) {
          PurgeProfile(doc.__refid);
          break;
        }
        if (typeof doc.name == 'string') {
          name = doc.name;
          break;
        }
      }

      profileData.push({
        refid,
        name,
        dataSize: sizeof(profiles[refid], true),
        coreProfile: await FindProfile(refid),
        isOwner: await userOwnsProfile(req, refid),
      });
    }

    const isAdmin = req.session.user!.admin;

    res.render(
      'plugin_profiles',
      data(req, plugin.Name, plugin.Identifier, {
        subtitle: 'Profiles',
        subidentifier: 'profiles',
        hasCustomPage: plugin.FirstProfilePage != null,
        profiles: profileData,
        isAdmin,
      })
    );
  })
);

// Leaderboard nicknames
function getGameNickname(docs: any[]) {
  for (const d of docs) {
    if (d?.collection === 'profile' && typeof d?.name === 'string' && d.name.trim().length > 0) {
      return d.name.trim();
    }
  }
  return null;
}
// Prevent showing offensive slurs in public pages
function sanitizeNickname(name: string) {
  const banned = ['nigger', 'nigga', 'faggot', 'kike', 'spic', 'chink', 'retard'];
  const lower = name.toLowerCase();
  if (banned.some(w => lower.includes(w)))
    return 'CENSORED';
  return name;
}
// Leaderboard auth
async function getLoggedRefid(req: Request) {
  const cardNumber = req.session?.user?.cardNumber;
  if (!cardNumber) return null;
  const card = await FindCard(cardNumber);
  return card ? card.__refid : null;
}
// Helpers extra + VF class
function clampInt(v: any, def: number, min: number, max: number) {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n))
    return def;
  return Math.min(max, Math.max(min, n));
}
function vfToClassNum(vf: number) {
  if (vf >= 20.0) return 10; // IMPERIAL
  if (vf >= 19.0) return 9; // CRIMSON
  if (vf >= 18.0) return 8; // ELDORA
  if (vf >= 17.0) return 7; // ARGENTO
  if (vf >= 16.0) return 6; // CORAL
  if (vf >= 15.0) return 5; // SCARLET
  if (vf >= 14.0) return 4; // CYAN
  if (vf >= 12.0) return 3; // DANDELION
  if (vf >= 10.0) return 2; // COBALT
  return 1; // SIENNA
}
function classNumToName(n: number) {
  return [
    'SIENNA',
    'COBALT',
    'DANDELION',
    'CYAN',
    'SCARLET',
    'CORAL',
    'ARGENTO',
    'ELDORA',
    'CRIMSON',
    'IMPERIAL',
  ][n - 1] ?? 'SIENNA';
}

// Leaderboard SDVX + IIDX
webui.get('/leaderboard', wrap(async (req, res, next) => {
  const game = String(req.query.game || 'sdvx').toLowerCase();
  const perPage = 20;
  const page = clampInt(req.query.page, 1, 1, 999999);

  // VF TOTAL Best50 SDVX
  if (game === 'sdvx') {
    const plugin = ROOT_CONTAINER.getPluginByID('sdvx@asphyxia');
    if (!plugin) return next();
    
    const docs = await APIFind({ identifier: plugin.Identifier, core: true }, null, {});
    const byRef = groupBy(docs, '__refid');
    const rows: any[] = [];
    
    for (const refid in byRef) {
      const bestByChart = new Map<string, number>();
      for (const d of byRef[refid]) {
        if (d.collection !== 'music') continue;
        if (typeof d.volforce !== 'number' || d.volforce <= 0) continue;
        if (d.mid == null || d.type == null) continue;
        const key = `${d.mid}:${d.type}`;
        const prev = bestByChart.get(key) ?? 0;
        if (d.volforce > prev) bestByChart.set(key, d.volforce);
      }
      if (bestByChart.size === 0) continue;
      
      const vfs = Array.from(bestByChart.values()).sort((a, b) => b - a);
      const top50 = vfs.slice(0, 50);
      const sumTop50 = top50.reduce((a, b) => a + b, 0);
      const vfTotal = sumTop50 / 1000;
      
      const coreProfile: any = await FindProfile(refid);
      const nickname = getGameNickname(byRef[refid]);
      const name = nickname ? sanitizeNickname(nickname) : (coreProfile?.name || '(no name)');
      
      const classNum = vfToClassNum(vfTotal);
      const className = classNumToName(classNum);
      const SDVX_ASSET_BASE = '/plugin/sdvx@asphyxia/static/asset';
      const classImg = `${SDVX_ASSET_BASE}/force/em6_${String(classNum).padStart(2, '0')}_i_eab.png`;
      
      let countryCode = 'xx';
      const cards = await FindCardsByRefid(refid);
      if (cards && Array.isArray(cards)) {
        for (const c of cards) {
          const u = await FindUserByCardNumber(c.cid);
          if (u && u.countryCode) {
            countryCode = u.countryCode.toLowerCase();
            break;
          }
        }
      }
      
      rows.push({
        refid,
        name,
        value: vfTotal,
        extraA: bestByChart.size,
        classNum,
        className,
        classImg,
        countryCode,
      });
    }
    rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    
    const myRefid = await getLoggedRefid(req);
    let myRank = null;
    let myRow = null;
    if (myRefid) {
      const idx = rows.findIndex(r => String(r.refid) === String(myRefid));
      if (idx >= 0) {
        myRank = idx + 1;
        myRow = rows[idx];
      }
    }
    
    const totalPlayers = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalPlayers / perPage));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * perPage;
    const pageRows = rows.slice(start, start + perPage);
    
    return res.render('leaderboard', data(req, 'Leaderboard', 'core', {
      game: 'sdvx',
      style: 'vf',
      rows: pageRows,
      totalPlayers,
      totalPages,
      page: safePage,
      perPage,
      myRank,
      myRow,
    }));
  }

  // IIDX Total EX score SP / DP
  if (game === 'iidx') {
    const plugin = ROOT_CONTAINER.getPluginByID('iidx@asphyxia');
    if (!plugin) return next();
    
    const style = String(req.query.style || 'sp').toLowerCase();
    const isSP = style === 'sp';
    const isDP = style === 'dp';
    const docs = await APIFind({ identifier: plugin.Identifier, core: true }, null, {});
    const byRef = groupBy(docs, '__refid');
    const rows: any[] = [];
    
    const profileCache = new Map<string, any>();
    const getProfileCached = async (refid: string) => {
      if (profileCache.has(refid)) return profileCache.get(refid);
      const p = await FindProfile(refid);
      profileCache.set(refid, p);
      return p;
    };
    
    for (const refid in byRef) {
      let totalEX = 0;
      let entries = 0;
      for (const d of byRef[refid]) {
        if (d.collection !== 'activity_mybest') continue;
        const playStyle = Number(d.play_style); // 0=SP, 1=DP
        if (isSP && playStyle !== 0) continue;
        if (isDP && playStyle !== 1) continue;
        const best = Number(d.best_score) || 0;
        const now = Number(d.now_score) || 0;
        const score = Math.max(best, now);
        if (score <= 0) continue;
        totalEX += score;
        entries++;
      }
      if (totalEX <= 0 || entries <= 0) continue;
      
      const coreProfile: any = await getProfileCached(refid);
      const nickname = getGameNickname(byRef[refid]);
      const name = nickname
        ? sanitizeNickname(nickname)
        : (coreProfile?.name || '(no name)');
        
      let countryCode = 'xx';
      const cards = await FindCardsByRefid(refid);
      if (cards && Array.isArray(cards)) {
        for (const c of cards) {
          const u = await FindUserByCardNumber(c.cid);
          if (u && u.countryCode) {
            countryCode = u.countryCode.toLowerCase();
            break;
          }
        }
      }
      
      rows.push({
        refid,
        name,
        value: totalEX,
        extraA: entries,
        countryCode,
      });
    }
    
    rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    
    const myRefid = await getLoggedRefid(req);
    let myRank = null;
    let myRow = null;
    if (myRefid) {
      const idx = rows.findIndex(r => String(r.refid) === String(myRefid));
      if (idx >= 0) {
        myRank = idx + 1;
        myRow = rows[idx];
      }
    }
    
    const totalPlayers = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalPlayers / perPage));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * perPage;
    const pageRows = rows.slice(start, start + perPage);
    
    return res.render('leaderboard', data(req, 'Leaderboard', 'core', {
      game: 'iidx',
      style,
      rows: pageRows,
      totalPlayers,
      totalPages,
      page: safePage,
      perPage,
      myRank,
      myRow,
    }));
  }
  return next();
}));

// Plugin Profile Page
webui.get(
  '/plugin/:plugin/profile',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const refid = req.query['refid'];

    if (refid == null) {
      return next();
    }

    const pageName = req.query['page'];

    let page = null;
    if (pageName == null) {
      page = plugin.FirstProfilePage;
    } else {
      page = `profile_${pageName.toString()}`;
    }

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid.toString());

    const ownerOnlyPages = ['profile_tachi', 'profile_nabla', 'profile_migrate'];
    if (ownerOnlyPages.includes(page) && !isAdmin && !isOwner) {
      return res.redirect(`/plugin/${req.params['plugin']}/profile?refid=${refid}`);
    }

    const content = await plugin.render(page, { query: req.query }, refid.toString());
    if (content == null) {
      return next();
    }

    const tabs = plugin.ProfilePages.filter(
      p => !ownerOnlyPages.includes(p) || isAdmin || isOwner
    ).map(p => ({
      name: startCase(p.substr(8)),
      link: p.substr(8),
    }));

    res.render(
      'custom_profile',
      data(req, plugin.Name, plugin.Identifier, {
        content,
        tabs,
        subtitle: 'Profiles',
        subidentifier: 'profiles',
        subsubtitle: startCase(page.substr(8)),
        subsubidentifier: page.substr(8),
        refid: refid.toString(),
        isAdmin,
        isOwner,
      })
    );
  })
);

// Plugin Custom Pages
webui.get(
  '/plugin/:plugin/:page',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);

    if (!plugin) {
      return next();
    }

    const pageName = req.params['page'];

    if (ADMIN_ONLY_PAGES.includes(pageName) && !req.session.user!.admin) {
      return res.redirect('/');
    }

    const content = await plugin.render(pageName, { query: req.query });
    if (content == null) {
      return next();
    }

    res.render(
      'custom',
      data(req, plugin.Name, plugin.Identifier, {
        content,
        subtitle: startCase(pageName),
        subidentifier: pageName,
      })
    );
  })
);

// General setting update
webui.post(
  '*',
  urlencoded({ extended: true, limit: '50mb' }),
  wrap(async (req, res) => {
    const page = req.query.page;

    if (isEmpty(req.body)) {
      res.sendStatus(400);
      return;
    }

    let plugin: string = null;
    if (req.path == '/') {
      plugin = 'core';
    } else if (req.path.startsWith('/plugin/')) {
      plugin = path.basename(req.path);
    }

    if (plugin == null) {
      res.redirect(req.originalUrl);
      return;
    }

    if (page) {
      // Custom page form
    } else {
      const configMap = CONFIG_MAP[plugin];
      const configData = plugin == 'core' ? CONFIG : CONFIG[plugin];

      if (configMap == null || configData == null) {
        res.redirect(req.originalUrl);
        return;
      }

      let needRestart = false;

      for (const [key, config] of configMap) {
        const current = configData[key];
        if (config.type == 'boolean') {
          configData[key] = req.body[key] ? true : false;
        }
        if (config.type == 'float') {
          configData[key] = parseFloat(req.body[key]);
          if (isNaN(configData[key])) {
            configData[key] = config.default;
          }
        }
        if (config.type == 'integer') {
          configData[key] = parseInt(req.body[key]);
          if (isNaN(configData[key])) {
            configData[key] = config.default;
          }
        }
        if (config.type == 'string') {
          configData[key] = req.body[key];
        }

        if (current !== configData[key]) {
          if (!validate(config, configData[key])) {
            if (config.needRestart) {
              needRestart = true;
            }
          }
        }
      }

      if (needRestart) {
        req.flash('formWarn', 'Some settings require a restart to be applied.');
      } else {
        req.flash('formOk', 'Updated');
      }

      SaveConfig();
    }

    res.redirect(req.originalUrl);
  })
);

// 404
webui.use(async (req, res, next) => {
  return res.status(404).render('404', data(req, '404 - Are you lost?', 'core'));
});

// 500 - Any server error
webui.use((err: any, req: any, res: any, next: any) => {
  return res.status(500).render('500', data(req, '500 - Oops', 'core', { err }));
});
