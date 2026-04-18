import { Router } from 'express';
import { json } from 'body-parser';
import {
  GetOAuthClient,
  CreateOAuthCode,
  ConsumeOAuthCode,
  CreateOAuthAccessToken,
  GetOAuthAccessToken,
  RefreshOAuthAccessToken,
  RevokeOAuthToken,
  CreateOAuthClient,
  GetOAuthClientsByUser,
  DeleteOAuthClient,
  GetOAuthTokensByUser,
  RevokeOAuthTokensByClientForUser,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';
import { data } from '../shared/helpers';

export const oauthRouter = Router();

import { CONFIG } from '../../utils/ArgConfig';

// Project Flower config endpoint
oauthRouter.get('/flower/config', (_req, res) => {
  res.json({ clientId: CONFIG.flower_client_id || '' });
});

// Project Flower OAuth callback
oauthRouter.get('/flower/callback', (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('Missing authorization code');
  const safeCode = code.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  res.send(`<html><body><script>
    if (window.opener) {
      window.opener.postMessage({ type: 'flower-auth', code: '${safeCode}' }, window.location.origin);
    }
    window.close();
  </script><p>Authorization complete. You can close this window.</p></body></html>`);
});

// =========================================
//             OAuth Provider (public endpoints)
// =========================================

oauthRouter.post(
  '/oauth/token',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, refresh_token } = req.body;

    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !client_id || !client_secret) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      }

      const client = await GetOAuthClient(client_id);
      if (!client || client.clientSecret !== client_secret) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
      }

      const authCode = await ConsumeOAuthCode(code);
      if (!authCode) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
      }

      if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Code does not match request parameters' });
      }

      const tokens = await CreateOAuthAccessToken(client_id, authCode.username, authCode.scopes);
      if (!tokens) {
        return res.status(500).json({ error: 'server_error', error_description: 'Failed to create access token' });
      }

      return res.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: 86400,
        refresh_token: tokens.refreshToken,
        scope: authCode.scopes.join(' '),
      });
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token || !client_id || !client_secret) {
        return res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      }

      const client = await GetOAuthClient(client_id);
      if (!client || client.clientSecret !== client_secret) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
      }

      const result = await RefreshOAuthAccessToken(refresh_token);
      if (!result) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
      }

      return res.json({
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
      });
    }

    return res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Only authorization_code and refresh_token grant types are supported' });
  })
);

oauthRouter.post(
  '/oauth/revoke',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { token } = req.body;
    if (token) await RevokeOAuthToken(token);
    res.json({ success: true });
  })
);

// =========================================
//             OAuth Provider (protected endpoints)
// =========================================
// NOTE: These routes will be protected by authMiddleware globally in index.ts
// after login/signup check is done, so we don't need to manually check req.session.user inside.

oauthRouter.get(
  '/oauth/authorize',
  wrap(async (req, res) => {
    const { response_type, client_id, redirect_uri, scope, state } = req.query as Record<string, string>;

    if (response_type !== 'code') {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Only response_type=code is supported.',
      }));
    }

    if (!client_id || !redirect_uri) {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Missing client_id or redirect_uri.',
      }));
    }

    const client = await GetOAuthClient(client_id);
    if (!client) {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Unknown application (invalid client_id).',
      }));
    }

    if (client.redirectUri !== redirect_uri) {
      return res.status(400).render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
        error: 'Redirect URI does not match the registered application.',
      }));
    }

    const scopes = scope ? scope.split(' ').filter(Boolean) : ['profile'];

    res.render('oauth_authorize', data(req, 'OAuth Authorization', 'core', {
      clientName: client.name,
      clientId: client_id,
      redirectUri: redirect_uri,
      scopes,
      state: state || '',
    }));
  })
);

oauthRouter.post(
  '/oauth/authorize',
  wrap(async (req, res) => {
    const { client_id, redirect_uri, scope, state, decision } = req.body;

    if (!client_id || !redirect_uri) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    const client = await GetOAuthClient(client_id);
    if (!client || client.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'Invalid client or redirect URI' });
    }

    const redirectUrl = new URL(redirect_uri);

    if (decision !== 'approve') {
      redirectUrl.searchParams.set('error', 'access_denied');
      if (state) redirectUrl.searchParams.set('state', state);
      return res.redirect(redirectUrl.toString());
    }

    const scopes = scope ? scope.split(' ').filter(Boolean) : ['profile'];
    const code = await CreateOAuthCode(client_id, req.session.user!.username, redirect_uri, scopes);
    if (!code) {
      redirectUrl.searchParams.set('error', 'server_error');
      if (state) redirectUrl.searchParams.set('state', state);
      return res.redirect(redirectUrl.toString());
    }

    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(redirectUrl.toString());
  })
);

oauthRouter.post(
  '/oauth/clients',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { name, redirect_uri } = req.body;
    if (!name || !redirect_uri) {
      return res.status(400).json({ success: false, description: 'Name and redirect_uri are required' });
    }

    try {
      new URL(redirect_uri);
    } catch {
      return res.status(400).json({ success: false, description: 'Invalid redirect_uri — must be a valid URL' });
    }

    const result = await CreateOAuthClient(name, redirect_uri, req.session.user!.username);
    if (!result) {
      return res.status(500).json({ success: false, description: 'Failed to create client' });
    }

    res.json({ success: true, clientId: result.clientId, clientSecret: result.clientSecret });
  })
);

oauthRouter.get(
  '/oauth/clients',
  wrap(async (req, res) => {
    const clients = await GetOAuthClientsByUser(req.session.user!.username);
    res.json({
      success: true,
      clients: clients.map((c: any) => ({
        clientId: c.clientId,
        name: c.name,
        redirectUri: c.redirectUri,
      })),
    });
  })
);

oauthRouter.delete(
  '/oauth/clients/:clientId',
  wrap(async (req, res) => {
    const username = req.session.user!.username;
    const { clientId } = req.params;

    const client = await GetOAuthClient(clientId);
    if (!client) {
      return res.status(404).json({ success: false, description: 'Client not found' });
    }
    // Allow owner or admin to delete
    if (client.createdBy !== username && !req.session.user!.admin) {
      return res.status(403).json({ success: false, description: 'Not authorized to delete this client' });
    }

    await DeleteOAuthClient(clientId, client.createdBy);
    res.json({ success: true });
  })
);

oauthRouter.get(
  '/oauth/authorized',
  wrap(async (req, res) => {
    const tokens = await GetOAuthTokensByUser(req.session.user!.username);
    const seen = new Set<string>();
    const apps: any[] = [];
    for (const t of tokens) {
      if (seen.has(t.clientId)) continue;
      seen.add(t.clientId);
      const client = await GetOAuthClient(t.clientId);
      apps.push({
        clientId: t.clientId,
        name: client ? client.name : 'Unknown App',
        scopes: t.scopes,
      });
    }
    res.json({ success: true, apps });
  })
);

oauthRouter.post(
  '/oauth/authorized/revoke',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const { client_id } = req.body;
    if (!client_id) return res.status(400).json({ success: false, description: 'client_id is required' });
    await RevokeOAuthTokensByClientForUser(client_id, req.session.user!.username);
    res.json({ success: true });
  })
);
