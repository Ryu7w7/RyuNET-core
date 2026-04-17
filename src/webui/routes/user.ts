import { Router } from 'express';
import {
  FindUserByUsername,
  UpdateUserAccount,
  GetAllUsers,
  SetUserAdmin,
} from '../../utils/EamuseIO';
import { wrap, adminMiddleware } from '../shared/middleware';
import { data } from '../shared/helpers';

export const userRouter = Router();

// Account settings (Personal)
userRouter.get(
  '/account',
  wrap(async (req, res) => {
    res.render('account', data(req, 'Account', 'core'));
  })
);

userRouter.post(
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

// Admin-only User Management
userRouter.use(adminMiddleware);

userRouter.get(
  '/users',
  wrap(async (req, res) => {
    const users = await GetAllUsers();
    res.render('users', data(req, 'Users', 'core', { users }));
  })
);

userRouter.post(
  '/users/toggle-admin',
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
  wrap(async (req, res) => {
    const targetUser = await FindUserByUsername(req.params.username);
    if (!targetUser) return res.redirect('/profiles');
    res.render('admin_account', data(req, 'Edit User Credentials', 'core', { targetUser }));
  })
);

userRouter.post(
  '/admin/account/:username',
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
