import { Router } from 'express';
import https from 'https';
import { stringify } from 'querystring';
import {
  CreateUserAccount,
  FindUserByDiscordId,
  UpdateUserAccount,
  CreateCabinet,
  GetCabinetsByUser,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';
import { CONFIG } from '../../utils/ArgConfig';
import { Logger } from '../../utils/Logger';

export const discordRouter = Router();

const DISCORD_API = 'https://discord.com/api/v10';

function httpsPost(url: string, data: any, headers: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      {
        method: 'POST',
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(body);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(stringify(data));
    req.end();
  });
}

function httpsGet(url: string, headers: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      {
        method: 'GET',
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve(body);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

discordRouter.get('/auth/discord', (req, res) => {
  const { action } = req.query; // 'login' or 'link'
  const state = action === 'link' ? 'link' : 'login';
  
  if (!CONFIG.discord_client_id) {
    req.flash('authError', 'Discord OAuth is not configured on this server.');
    return res.redirect('/login');
  }

  const redirectUri = encodeURIComponent(`http://${req.get('host')}/auth/discord/callback`);
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CONFIG.discord_client_id}&redirect_uri=${redirectUri}&response_type=code&scope=identify&state=${state}`;
  res.redirect(url);
});

discordRouter.get(
  '/auth/discord/callback',
  wrap(async (req, res) => {
    const { code, state } = req.query;

    if (!code) {
      req.flash('authError', 'Discord authorization failed.');
      return res.redirect('/login');
    }

    const redirectUri = `http://${req.get('host')}/auth/discord/callback`;

    // 1. Exchange code for token
    const tokenData = await httpsPost(
      `${DISCORD_API}/oauth2/token`,
      {
        client_id: CONFIG.discord_client_id,
        client_secret: CONFIG.discord_client_secret,
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
      },
      { 'Content-Type': 'application/x-www-form-urlencoded' }
    );

    if (!tokenData.access_token) {
      req.flash('authError', 'Failed to authenticate with Discord.');
      return res.redirect(state === 'link' ? '/settings' : '/login');
    }

    // 2. Get user info
    const userData = await httpsGet(`${DISCORD_API}/users/@me`, {
      Authorization: `Bearer ${tokenData.access_token}`,
    });

    if (!userData.id) {
      req.flash('authError', 'Failed to get Discord profile.');
      return res.redirect(state === 'link' ? '/settings' : '/login');
    }

    const discordId = userData.id;
    const discordUsername = userData.username;

    // Linking logic
    if (state === 'link') {
      if (!req.session.user) {
        return res.redirect('/login');
      }

      const existingUserLinked = await FindUserByDiscordId(discordId);
      if (existingUserLinked && existingUserLinked.username !== req.session.user.username) {
        req.flash('formWarn', 'This Discord account is already linked to another RyuNET account.');
        return res.redirect('/account');
      }

      await UpdateUserAccount(req.session.user.username, {
        discordId,
        discordUsername,
      });

      // Give them a default cabinet if they don't have one
      const cabinets = await GetCabinetsByUser(req.session.user.username);
      if (cabinets.length === 0) {
        await CreateCabinet(req.session.user.username, 'Default Cabinet');
      }

      req.flash('formOk', 'Discord account linked successfully.');
      return res.redirect('/account');
    }

    // Login logic
    const user = await FindUserByDiscordId(discordId);
    
    if (user) {
      // Login
      req.session.user = {
        username: user.username,
        cardNumber: user.cardNumber,
        admin: user.admin || false,
      };
      return res.redirect(user.admin ? '/' : '/about');
    } else {
      // Auto-register
      const desiredUsername = discordUsername;
      const pass = Math.random().toString(36).slice(-8); // Random password just in case

      const account = await CreateUserAccount(
        desiredUsername,
        pass,
        '', // No card initially
        false,
        null,
        discordId,
        discordUsername
      );

      if (!account) {
        req.flash('authError', 'Username already taken or registration failed. Please contact admin.');
        return res.redirect('/login');
      }

      // Automatically create a cabinet for the new user
      await CreateCabinet(desiredUsername, 'Default Cabinet');

      req.session.user = {
        username: desiredUsername,
        cardNumber: '',
        admin: false,
      };
      Logger.info(`New user registered via Discord: ${desiredUsername}`);
      return res.redirect('/about');
    }
  })
);
