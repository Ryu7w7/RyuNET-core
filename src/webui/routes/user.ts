import { Router } from 'express';
import {
  FindUserByUsername,
  UpdateUserAccount,
  GetAllUsers,
  SetUserAdmin,
  GenerateApiToken,
  GetApiTokenExists,
  DeleteApiToken,
  FindCard,
  FindProfile,
  GetAllCabinets,
  FindUserByCardNumber,
} from '../../utils/EamuseIO';
import { json } from 'body-parser';
import { wrap, adminMiddleware } from '../shared/middleware';
import { data } from '../shared/helpers';

export const userRouter = Router();

// Account settings (Personal)
userRouter.get(
  '/account',
  wrap(async (req, res) => {
    const fullUser = await FindUserByUsername(req.session.user!.username);
    res.render('account', data(req, 'Account', 'core', { fullUser }));
  })
);

userRouter.post(
  '/account',
  wrap(async (req, res) => {
    const { username, password, confirmPassword, cardNumber } = req.body;
    const currentUsername = req.session.user!.username;

    if (password && password !== confirmPassword) {
      req.flash('formWarn', 'Passwords do not match.');
      return res.redirect('/account');
    }

    if (password && password.length < 4) {
      req.flash('formWarn', 'Password must be at least 4 characters.');
      return res.redirect('/account');
    }

    const updateFields: { username?: string; password?: string; cardNumber?: string } = {};

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

    if (cardNumber !== undefined) {
      const normalized = String(cardNumber)
        .toUpperCase()
        .trim()
        .replace(/[\s\-]/g, '')
        .replace(/O/g, '0')
        .replace(/I/g, '1');

      if (normalized === '' || /^[0-9A-F]{16}$/.test(normalized)) {
        if (normalized !== '' && normalized !== req.session.user!.cardNumber) {
          const existing = await FindUserByCardNumber(normalized);
          if (existing) {
            req.flash('formWarn', 'This card number is already registered to another user.');
            return res.redirect('/account');
          }
        }
        updateFields.cardNumber = normalized;
      } else {
        req.flash('formWarn', 'Invalid card number format.');
        return res.redirect('/account');
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await UpdateUserAccount(currentUsername, updateFields);
      if (updateFields.username) {
        req.session.user!.username = updateFields.username;
      }
      if (updateFields.cardNumber !== undefined) {
        req.session.user!.cardNumber = updateFields.cardNumber;
      }
      req.flash('formOk', 'Account updated.');
    }

    res.redirect('/account');
  })
);

userRouter.post(
  '/account/unlink-discord',
  wrap(async (req, res) => {
    await UpdateUserAccount(req.session.user!.username, {
      discordId: null,
      discordUsername: null,
    });
    req.flash('formOk', 'Discord account unlinked successfully.');
    res.redirect('/account');
  })
);

// API token management
userRouter.post(
  '/account/api-token',
  json({ limit: '1mb' }),
  wrap(async (req, res) => {
    const token = await GenerateApiToken(req.session.user!.username);
    if (!token) {
      if (req.headers.accept === 'application/json' || (req as any).isApiAuth) {
        return res.status(500).json({ success: false, description: 'Failed to generate token' });
      }
      req.flash('formWarn', 'Failed to generate API token.');
      return res.redirect('/account');
    }

    if (req.headers.accept === 'application/json' || (req as any).isApiAuth) {
      return res.json({ success: true, token });
    }
    req.flash('formOk', `API token generated. Copy it now — it won't be shown again: ${token}`);
    res.redirect('/account');
  })
);

userRouter.post(
  '/account/api-token/revoke',
  wrap(async (req, res) => {
    await DeleteApiToken(req.session.user!.username);
    if (req.headers.accept === 'application/json' || (req as any).isApiAuth) {
      return res.json({ success: true });
    }
    req.flash('formOk', 'API token revoked.');
    res.redirect('/account');
  })
);

userRouter.get(
  '/account/api-token/status',
  wrap(async (req, res) => {
    const exists = await GetApiTokenExists(req.session.user!.username);
    res.json({ success: true, exists });
  })
);

// Current user info (JSON, for API/OAuth consumers)
userRouter.get(
  '/api/me',
  wrap(async (req, res) => {
    const user = req.session.user!;
    const result: any = { success: true, username: user.username, admin: user.admin };

    if (user.cardNumber) {
      result.cardNumber = user.cardNumber;
      const card = await FindCard(user.cardNumber);
      if (card && card.__refid) {
        result.refid = card.__refid;
        const profile = await FindProfile(card.__refid);
        if (profile && profile.name) {
          result.playerName = profile.name;
        }
      }
    }

    res.json(result);
  })
);

// Online users
userRouter.get(
  '/api/online-users',
  wrap(async (req, res) => {
    const threshold = Date.now() - 5 * 60 * 1000; // 5 minutes
    const cabinets = await GetAllCabinets();
    const onlineCount = cabinets.filter(c => c.lastSeen && c.lastSeen > threshold).length;
    res.json({ online: onlineCount });
  })
);

// Admin-only User Management
userRouter.get(
  '/users',
  adminMiddleware,
  wrap(async (req, res) => {
    const users = await GetAllUsers();
    res.render('users', data(req, 'Users', 'core', { users }));
  })
);

userRouter.post(
  '/users/toggle-admin',
  adminMiddleware,
  wrap(async (req, res) => {
    const { username } = req.body;
    if (username === req.session.user!.username) return res.redirect('/users');

    const target = await FindUserByUsername(username);
    if (target) {
      await SetUserAdmin(username, !target.admin);
    }
    res.redirect('/users');
  })
);

userRouter.get(
  '/admin/account/:username',
  adminMiddleware,
  wrap(async (req, res) => {
    const targetUser = await FindUserByUsername(req.params.username);
    if (!targetUser) return res.redirect('/profiles');
    res.render('admin_account', data(req, 'Edit User Credentials', 'core', { targetUser }));
  })
);

userRouter.post(
  '/admin/account/:username',
  adminMiddleware,
  wrap(async (req, res) => {
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
