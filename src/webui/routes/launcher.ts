import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  AuthenticateUser,
  GetApiTokenByToken,
  GenerateApiToken,
  DeleteApiToken,
  GetCabinetsByUser,
  FindCard,
  FindProfile,
  GetCabinetByPCBID,
  FindUserByUsername,
} from '../../utils/EamuseIO';
import { CONFIG } from '../../utils/ArgConfig';
import { wrap, bearerTokenMiddleware } from '../shared/middleware';

export const launcherRouter = Router();

const LAUNCHER_AUTH_LIMIT = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});

// ──────────────────────────────────────────────
// Public: login → returns API token
// ──────────────────────────────────────────────
launcherRouter.post(
  '/api/launcher/login',
  LAUNCHER_AUTH_LIMIT,
  wrap(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required.' });
    }

    const user = await AuthenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    await DeleteApiToken(username);
    const token = await GenerateApiToken(username);
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to generate token.' });
    }

    return res.json({
      success: true,
      token,
      user: {
        username: user.username,
        admin: user.admin || false,
        cardNumber: user.cardNumber || '',
      },
    });
  })
);

// ──────────────────────────────────────────────
// Public: revoke token
// ──────────────────────────────────────────────
launcherRouter.post(
  '/api/launcher/logout',
  wrap(async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'No token provided.' });
    }
    const token = auth.slice(7);
    const user = await GetApiTokenByToken(token);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token.' });
    }
    await DeleteApiToken(user.username);
    return res.json({ success: true, message: 'Token revoked.' });
  })
);

// ──────────────────────────────────────────────
// All routes below require Bearer token
// ──────────────────────────────────────────────
launcherRouter.use('/api/launcher', bearerTokenMiddleware);

// ──────────────────────────────────────────────
// GET /api/launcher/me
// ──────────────────────────────────────────────
launcherRouter.get(
  '/api/launcher/me',
  wrap(async (req, res) => {
    const session = req.session.user;
    if (!session) {
      return res.status(401).json({ success: false, error: 'Not authenticated.' });
    }

    const dbUser = await FindUserByUsername(session.username);
    const cabinets = await GetCabinetsByUser(session.username);

    // Get profile from user's registered card
    let profile: any = null;
    if (session.cardNumber) {
      const card = await FindCard(session.cardNumber);
      if (card?.__refid) {
        profile = await FindProfile(card.__refid);
      }
    }

    return res.json({
      success: true,
      user: {
        username: session.username,
        admin: session.admin || false,
        cardNumber: session.cardNumber || '',
        countryCode: dbUser?.countryCode || '',
      },
      profile: profile
        ? {
            refid: profile.__refid,
            name: profile.name || 'Guest',
            model: profile.models?.[0] || '',
          }
        : null,
      cabinets: (cabinets || []).map((c: any) => ({
        pcbid: c.pcbid,
        name: c.name || '',
        lastSeen: c.lastSeen || 0,
      })),
    });
  })
);

// ──────────────────────────────────────────────
// GET /api/launcher/config
// ──────────────────────────────────────────────
launcherRouter.get(
  '/api/launcher/config',
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated.' });
    }

    // Read CCJ plugin config from INI (stored under plugin identifier)
    const ccjCfg = (CONFIG as any)['ccj@asphyxia'] || {};

    return res.json({
      success: true,
      server: {
        url: `http://${CONFIG.bind || '127.0.0.1'}:${CONFIG.port}`,
        name: CONFIG.server_name || 'CCJ Server',
      },
      relay: {
        enabled: ccjCfg.ccj_relay_enabled === true,
        publicIp: ccjCfg.ccj_relay_public_ip || CONFIG.bind || '127.0.0.1',
        portRange: ccjCfg.ccj_relay_port_range || '50000-50100',
        matchingTime: ccjCfg.ccj_host_matching_time || 350,
      },
    });
  })
);

// ──────────────────────────────────────────────
// POST /api/launcher/relay/register
// ──────────────────────────────────────────────
launcherRouter.post(
  '/api/launcher/relay/register',
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated.' });
    }

    const { ip, portRange } = req.body;
    if (!ip || !portRange) {
      return res.status(400).json({ success: false, error: 'IP and portRange required.' });
    }

    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      return res.status(400).json({ success: false, error: 'Invalid IP format.' });
    }

    const ports = portRange.split('-').map(Number);
    if (ports.length !== 2 || ports[0] < 1024 || ports[1] > 65535 || ports[0] >= ports[1]) {
      return res.status(400).json({ success: false, error: 'Invalid port range (1024-65535).' });
    }

    const { UpsertRelayNode } = require('../../utils/EamuseIO');
    await UpsertRelayNode({
      ip,
      portRange,
      portMin: ports[0],
      portMax: ports[1],
      registeredBy: req.session.user.username,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
    });

    return res.json({ success: true, message: `Relay node ${ip}:${portRange} registered.` });
  })
);

// ──────────────────────────────────────────────
// GET /api/launcher/relay/nodes
// Returns active relay nodes
// ──────────────────────────────────────────────
launcherRouter.get(
  '/api/launcher/relay/nodes',
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated.' });
    }

    const { GetRelayNodes } = require('../../utils/EamuseIO');
    const nodes = await GetRelayNodes();
    return res.json({ success: true, nodes: nodes || [] });
  })
);

// ──────────────────────────────────────────────
// GET /api/launcher/cabinets/:pcbid
// Returns info about a specific cabinet
// ──────────────────────────────────────────────
launcherRouter.get(
  '/api/launcher/cabinets/:pcbid',
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: 'Not authenticated.' });
    }

    const cabinet = await GetCabinetByPCBID(req.params.pcbid);
    if (!cabinet) {
      return res.status(404).json({ success: false, error: 'Cabinet not found.' });
    }

    return res.json({
      success: true,
      cabinet: {
        pcbid: cabinet.pcbid,
        name: cabinet.name || '',
        username: cabinet.username,
        lastSeen: cabinet.lastSeen || 0,
      },
    });
  })
);
