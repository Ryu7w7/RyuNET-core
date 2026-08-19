import { Router, json } from 'express';
import https from 'https';
import crypto from 'crypto';
import { CONFIG } from '../../utils/ArgConfig';
import {
  SaveLastfmSession,
  GetLastfmSession,
  DeleteLastfmSession,
  GetLastfmAutoScrobble,
  SaveLastfmAutoScrobble,
  FindCard,
  APIUpsert,
  APIRemove,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';
import { userOwnsProfile } from '../shared/helpers';
import { Logger } from '../../utils/Logger';

export const lastfmRouter = Router();
const LASTFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';

// Plugin identifiers that support Last.fm auto-scrobbling.
// Add more here as support is added to other game plugins.
const SCROBBLE_PLUGINS = ['sdvx@asphyxia', 'iidx@asphyxia'];

function md5(str: string): string {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

// Last.fm API request signing: https://www.last.fm/api/authspec
function signParams(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).sort();
  let sig = '';
  for (const k of keys) sig += k + params[k];
  sig += secret;
  return md5(sig);
}

function lastfmGet(params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, format: 'json' }).toString();
  return new Promise((resolve, reject) => {
    https
      .get(`${LASTFM_API_BASE}?${qs}`, (res: any) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('Failed to parse Last.fm response')); }
        });
      })
      .on('error', reject);
  });
}

// Public API key endpoint — shared secret NEVER leaves the server
lastfmRouter.get('/config', (_req, res) => {
  res.json({ apiKey: CONFIG.lastfm_api_key || '' });
});

// Popup callback window: receives ?token= from Last.fm and postMessages it back to the opener
lastfmRouter.get('/callback', (req, res) => {
  const token = req.query.token as string;
  if (!token) return res.status(400).send('Missing token');
  const safeToken = token.replace(/["'<>]/g, '');
  res.send(`<html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'lastfm-auth', token: '${safeToken}' }, window.location.origin);
    }
    window.close();
  </script><p>Authorization complete. You can close this window.</p></body></html>`);
});

// Exchange the one-time token for a permanent session key
lastfmRouter.post(
  '/exchange',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const token = req.body.token;
    if (!token) return res.status(400).json({ success: false, description: 'Missing token' });
    if (!CONFIG.lastfm_api_key || !CONFIG.lastfm_api_secret) {
      return res.json({ success: false, description: 'Last.fm is not configured on this server' });
    }

    const params: Record<string, string> = {
      method: 'auth.getSession',
      api_key: CONFIG.lastfm_api_key,
      token,
    };
    params.api_sig = signParams(params, CONFIG.lastfm_api_secret);

    let result: any;
    try {
      result = await lastfmGet(params);
    } catch (err) {
      Logger.error(err);
      return res.json({ success: false, description: 'Failed to reach Last.fm' });
    }

    if (!result || result.error || !result.session || !result.session.key) {
      return res.json({ success: false, description: (result && result.message) || 'Authorization failed' });
    }

    await SaveLastfmSession(req.session.user!.username, result.session.key, result.session.name);
    res.json({ success: true, username: result.session.name });
  })
);

lastfmRouter.get(
  '/status',
  wrap(async (req, res) => {
    const session = await GetLastfmSession(req.session.user!.username);
    res.json({ authorized: !!session, username: session ? session.lastfmUsername : null });
  })
);

lastfmRouter.post(
  '/disconnect',
  wrap(async (req, res) => {
    const cardNumber = req.session.user!.cardNumber;
    if (cardNumber) {
      const card = await FindCard(cardNumber);
      if (card && card.__refid) {
        await SaveLastfmAutoScrobble(card.__refid, false);
        for (const identifier of SCROBBLE_PLUGINS) {
          await APIRemove({ identifier, core: false }, { collection: 'lastfm_auto_scrobble', refid: card.__refid });
        }
      }
    }
    await DeleteLastfmSession(req.session.user!.username);
    res.json({ success: true });
  })
);

lastfmRouter.get(
  '/auto-scrobble',
  wrap(async (req, res) => {
    const refid = req.query.refid as string;
    if (!refid) return res.status(400).json({ success: false, description: 'Missing refid' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    const enabled = await GetLastfmAutoScrobble(refid);
    res.json({ success: true, enabled });
  })
);

lastfmRouter.post(
  '/auto-scrobble',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { refid, enabled } = req.body;
    if (!refid || typeof enabled !== 'boolean')
      return res.status(400).json({ success: false, description: 'Missing refid or enabled' });

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid);
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    await SaveLastfmAutoScrobble(refid, enabled);

    if (enabled) {
      const session = await GetLastfmSession(req.session.user!.username);
      if (session) {
        for (const identifier of SCROBBLE_PLUGINS) {
          await APIUpsert(
            { identifier, core: false },
            { collection: 'lastfm_auto_scrobble', refid },
            {
              collection: 'lastfm_auto_scrobble',
              refid,
              sessionKey: session.sessionKey,
              apiKey: CONFIG.lastfm_api_key,
              apiSecret: CONFIG.lastfm_api_secret,
            }
          );
        }
      }
    } else {
      for (const identifier of SCROBBLE_PLUGINS) {
        await APIRemove({ identifier, core: false }, { collection: 'lastfm_auto_scrobble', refid });
      }
    }

    res.json({ success: true });
  })
);
