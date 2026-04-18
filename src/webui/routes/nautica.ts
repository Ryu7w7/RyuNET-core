import { Router } from 'express';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { CONFIG, SaveConfig } from '../../utils/ArgConfig';
import { APIFind, PLUGIN_PATH } from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';

export const nauticaRouter = Router();

nauticaRouter.get(
  '/api/nautica/version',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    if (!gameRoot) return res.json({ version: null });

    const modBase = path.join(gameRoot, 'data_mods', mixName);
    if (!existsSync(modBase)) {
      require('fs').mkdirSync(modBase, { recursive: true });
    }

    const xmlPath = path.join(modBase, 'others', 'music_db.merged.xml');
    const musicBase = path.join(modBase, 'music');
    let hash = '0';
    try {
      const xmlStat = existsSync(xmlPath) ? require('fs').statSync(xmlPath) : null;
      const songFolders = existsSync(musicBase) ? readdirSync(musicBase).sort().join(',') : '';
      const raw = `${xmlStat ? xmlStat.mtimeMs : 0}|${songFolders}`;
      let h = 0;
      for (let i = 0; i < raw.length; i++) {
        h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
      }
      hash = Math.abs(h).toString(36);
    } catch {}

    res.json({ version: hash, mixName });
  })
);

nauticaRouter.get(
  '/api/nautica/manifest',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';

    const sdvxPlugin = { identifier: 'sdvx@asphyxia', core: false };
    const songs = (await APIFind(sdvxPlugin, { collection: 'nautica_song' })) as any[];
    const ready = (songs || []).filter(s => s.status === 'ready');

    const charts = ready.map(s => ({
      mid: s.mid,
      nauticaId: s.nauticaId,
      title: s.title,
      artist: s.artist,
      convertedAt: s.convertedAt || 0,
      driveFileId: s.driveFileId || null,
      size: s.driveFileSize || 0,
      downloadUrl: s.driveFileId
        ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(s.driveFileId)}`
        : null,
    }));

    res.json({ mixName, charts });
  })
);

nauticaRouter.get(
  '/api/drive-oauth-start',
  wrap(async (req, res) => {
    if (!req.session.user?.admin) return res.sendStatus(403);

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const clientId = (sdvxConfig.sdvx_drive_oauth_client_id || '').trim();
    const clientSecret = (sdvxConfig.sdvx_drive_oauth_client_secret || '').trim();
    if (!clientId || !clientSecret) {
      return res.status(400).send('Drive OAuth Client ID and Client Secret must be set in plugin settings first.');
    }

    const redirectUri = `${req.protocol}://${req.get('host')}/api/drive-oauth-callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/drive',
      access_type: 'offline',
      prompt: 'consent',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  })
);

nauticaRouter.get(
  '/api/drive-oauth-callback',
  wrap(async (req, res) => {
    if (!req.session.user?.admin) return res.status(403).send('Admin session required.');

    const code = req.query.code;
    const error = req.query.error;
    if (error) return res.status(400).send(`Google returned an error: ${error}`);
    if (!code || typeof code !== 'string') return res.status(400).send('Missing authorization code.');

    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const clientId = (sdvxConfig.sdvx_drive_oauth_client_id || '').trim();
    const clientSecret = (sdvxConfig.sdvx_drive_oauth_client_secret || '').trim();
    if (!clientId || !clientSecret) return res.status(400).send('Drive OAuth client not configured.');

    const redirectUri = `${req.protocol}://${req.get('host')}/api/drive-oauth-callback`;

    try {
      const tokens = await exchangeAuthCodeForTokens(code, clientId, clientSecret, redirectUri);
      if (!tokens || !tokens.refresh_token) {
        return res.status(500).send(
          'Google did not return a refresh token. Revoke the app at https://myaccount.google.com/permissions and try again.'
        );
      }
      const section = CONFIG['sdvx@asphyxia'] || {};
      section.sdvx_drive_oauth_refresh_token = tokens.refresh_token;
      CONFIG['sdvx@asphyxia'] = section;
      SaveConfig();

      res.send(
        `<html><body style="font-family:sans-serif;padding:2rem;background:#1a1a1e;color:#ddd">
          <h2 style="color:#7cb">Google Drive authorized</h2>
          <p>Refresh token saved. You can close this window and return to the admin page.</p>
          <script>setTimeout(function(){window.close();},2000);</script>
        </body></html>`
      );
    } catch (err: any) {
      res.status(500).send(`OAuth exchange failed: ${err.message || err}`);
    }
  })
);

function exchangeAuthCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number } | null> {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString();

    const https = require('https');
    const req = https.request(
      {
        method: 'POST',
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return reject(new Error(`token endpoint returned HTTP ${res.statusCode}: ${text}`));
          }
          try { resolve(JSON.parse(text)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

nauticaRouter.get(
  '/api/nautica/music-db-xml',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    if (!gameRoot) return res.status(400).json({ error: 'Game directory not configured' });

    const xmlPath = path.join(gameRoot, 'data_mods', mixName, 'others', 'music_db.merged.xml');
    if (!existsSync(xmlPath)) return res.sendStatus(404);

    res.set('Content-Type', 'application/xml');
    res.set('Content-Disposition', `attachment; filename="music_db.merged.xml"`);
    res.sendFile(xmlPath);
  })
);

nauticaRouter.get(
  '/api/nautica/download-all',
  wrap(async (req, res) => {
    const sdvxConfig = CONFIG['sdvx@asphyxia'] || {};
    const gameRoot = sdvxConfig.sdvx_eg_root_dir;
    const mixName = sdvxConfig.sdvx_custom_mix_name || 'asphyxia_custom';
    if (!gameRoot) return res.status(400).json({ error: 'Game directory not configured' });

    const modBase = path.join(gameRoot, 'data_mods', mixName);
    const musicBase = path.join(modBase, 'music');
    if (!existsSync(musicBase) || readdirSync(musicBase).length === 0) {
      return res.status(404).json({ error: 'No custom charts available' });
    }

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${mixName}.zip"`);
    archive.pipe(res);
    archive.directory(modBase, `data_mods/${mixName}`);
    await archive.finalize();
  })
);

nauticaRouter.get(
  '/api/nautica/sync-script',
  wrap(async (req, res) => {
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const templatePath = path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'sync_custom_charts.ps1');
    if (!existsSync(templatePath)) return res.status(404).send('Sync script template not found');
    const script = readFileSync(templatePath, 'utf8')
      .replace(/\$ServerUrl\s*=\s*"[^"]*"/, `$ServerUrl    = "${serverUrl}"`);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="sync_custom_charts.ps1"');
    res.send(script);
  })
);

nauticaRouter.get(
  '/api/nautica/sync-script-bat',
  wrap(async (req, res) => {
    const bat = '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_custom_charts.ps1"\r\n';
    res.set('Content-Type', 'application/x-batch');
    res.set('Content-Disposition', 'attachment; filename="sync_and_play.bat"');
    res.send(bat);
  })
);

nauticaRouter.get(
  '/api/nautica/sync-bundle',
  wrap(async (req, res) => {
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const templatePath = path.join(PLUGIN_PATH, 'sdvx@asphyxia', 'webui', 'asset', 'sync_custom_charts.ps1');
    if (!existsSync(templatePath)) return res.status(404).send('Sync script template not found');

    const ps1 = readFileSync(templatePath, 'utf8')
      .replace(/\$ServerUrl\s*=\s*"[^"]*"/, `$ServerUrl    = "${serverUrl}"`);
    const bat = '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync_custom_charts.ps1"\r\n';

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="custom_charts_sync.zip"');
    archive.pipe(res);
    archive.append(ps1, { name: 'sync_custom_charts.ps1' });
    archive.append(bat, { name: 'sync_and_play.bat' });
    await archive.finalize();
  })
);
