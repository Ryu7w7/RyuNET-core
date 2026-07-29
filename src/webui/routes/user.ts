import { Router, urlencoded } from 'express';
import {
  FindUserByUsername,
  UpdateUserAccount,
  GetAllUsers,
  SetUserAdmin,
  GenerateApiToken,
  GetApiTokenExists,
  DeleteApiToken,
  FindCard,
  GetAllCabinets,
  FindUserByCardNumber,
  UpdateProfile,
  FindCardsByRefid,
  CreateCard,
  FindProfile,
  DeleteCard,
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
    let profile = null;
    
    if (fullUser.cardNumber) {
      const card = await FindCard(fullUser.cardNumber);
      if (card && card.__refid) {
        profile = await FindProfile(card.__refid);
      }
    }

    res.render('account', data(req, 'Account', 'core', { fullUser, profile }));
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
  '/account/profile',
  wrap(async (req, res) => {
    const fullUser = await FindUserByUsername(req.session.user!.username);
    if (!fullUser || !fullUser.cardNumber) {
      req.flash('formWarn', 'You must link a card number before setting up a profile.');
      return res.redirect('/account');
    }

    const card = await FindCard(fullUser.cardNumber);
    if (!card || !card.__refid) {
      req.flash('formWarn', 'No profile found for your card number. Please play a game first.');
      return res.redirect('/account');
    }

    const update: any = {};
    if (req.body.pin) update.pin = req.body.pin;
    if (req.body.name) update.name = req.body.name;
    if (req.body.paseli !== undefined && req.body.paseli !== '') {
      let paseli = parseInt(String(req.body.paseli), 10);
      if (!isNaN(paseli)) {
        paseli = Math.max(0, Math.min(100000, paseli));
        update.paseli = paseli;
      }
    }

    if (Object.keys(update).length > 0) {
      await UpdateProfile(card.__refid, update);
      req.flash('formOk', 'Profile details updated.');
    }
    
    res.redirect('/account');
  })
);

userRouter.get(
  '/cards',
  wrap(async (req, res) => {
    const fullUser = await FindUserByUsername(req.session.user!.username);
    if (!fullUser || !fullUser.cardNumber) {
      req.flash('formWarn', 'You must link a card number before managing cards.');
      return res.redirect('/account');
    }

    const card = await FindCard(fullUser.cardNumber);
    if (!card || !card.__refid) {
      req.flash('formWarn', 'No profile found for your card number. Please play a game first.');
      return res.redirect('/account');
    }

    const profileCards = await FindCardsByRefid(card.__refid);
    res.render('cards', data(req, 'Cards', 'core', { profileCards, refid: card.__refid }));
  })
);

userRouter.post(
  '/cards',
  wrap(async (req, res) => {
    const fullUser = await FindUserByUsername(req.session.user!.username);
    if (!fullUser || !fullUser.cardNumber) return res.redirect('/cards');

    const mainCard = await FindCard(fullUser.cardNumber);
    if (!mainCard || !mainCard.__refid) return res.redirect('/cards');

    const card = String(req.body.card || '');
    const normalized = card
      .toUpperCase()
      .trim()
      .replace(/[\s\-]/g, '')
      .replace(/O/g, '0')
      .replace(/I/g, '1');

    if (/^[0-9A-F]{16}$/.test(normalized)) {
      if (!(await FindCard(normalized))) {
        await CreateCard(normalized, mainCard.__refid, normalized);
        req.flash('formOk', 'Card added successfully.');
      } else {
        req.flash('formWarn', 'Card already exists.');
      }
    } else {
      req.flash('formWarn', 'Invalid card format.');
    }
    res.redirect('/cards');
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

// Admin: manage profile data + cards for a specific refid

userRouter.get(
  '/admin/profile/:refid',
  adminMiddleware,
  wrap(async (req, res) => {
    const refid = req.params.refid;
    const profile = await FindProfile(refid);
    if (!profile) return res.redirect('/profiles');

    const profileCards = await FindCardsByRefid(refid);

    // Try to find linked account username
    let accountUsername: string | null = null;
    if (profileCards && profileCards.length > 0) {
      for (const c of profileCards) {
        const u = await FindUserByCardNumber(c.cid);
        if (u) { accountUsername = u.username; break; }
      }
    }

    res.render('admin_profile', data(req, `Admin: ${profile.name}`, 'core', {
      profile,
      profileCards: profileCards || [],
      accountUsername,
      refid,
    }));
  })
);

userRouter.post(
  '/admin/profile/:refid',
  urlencoded({ extended: true }),
  adminMiddleware,
  wrap(async (req, res) => {
    const refid = req.params.refid;
    const profile = await FindProfile(refid);
    if (!profile) return res.redirect('/profiles');

    const update: any = {};
    if (req.body.name) update.name = req.body.name;
    if (req.body.pin) update.pin = req.body.pin;
    if (req.body.paseli !== undefined && req.body.paseli !== '') {
      let paseli = parseInt(String(req.body.paseli), 10);
      if (!isNaN(paseli)) {
        paseli = Math.max(0, Math.min(100000, paseli));
        update.paseli = paseli;
      }
    }

    if (Object.keys(update).length > 0) {
      await UpdateProfile(refid, update);
      req.flash('formOk', 'Profile updated.');
    }

    res.redirect(`/admin/profile/${refid}`);
  })
);

// Admin: add card to profile
userRouter.post(
  '/admin/profile/:refid/card',
  urlencoded({ extended: true }),
  adminMiddleware,
  wrap(async (req, res) => {
    const refid = req.params.refid;
    const card = String(req.body.cid || '');
    const normalized = card
      .toUpperCase()
      .trim()
      .replace(/[\s\-]/g, '')
      .replace(/O/g, '0')
      .replace(/I/g, '1');

    if (/^[0-9A-F]{16}$/.test(normalized)) {
      if (!(await FindCard(normalized))) {
        await CreateCard(normalized, refid, normalized);
        req.flash('formOk', 'Card added.');
      } else {
        req.flash('formWarn', 'Card already exists.');
      }
    } else {
      req.flash('formWarn', 'Invalid card format (must be 16 hex chars).');
    }
    res.redirect(`/admin/profile/${refid}`);
  })
);

// Admin: remove card from profile
userRouter.post(
  '/admin/profile/:refid/card/delete',
  urlencoded({ extended: true }),
  adminMiddleware,
  wrap(async (req, res) => {
    const refid = req.params.refid;
    const cid = String(req.body.cid || '');
    if (cid) {
      const profileCards = await FindCardsByRefid(refid);
      if (profileCards && profileCards.length <= 1) {
        req.flash('formWarn', 'Cannot delete the only card on this profile.');
      } else {
        await DeleteCard(cid);
        req.flash('formOk', 'Card removed.');
      }
    }
    res.redirect(`/admin/profile/${refid}`);
  })
);
