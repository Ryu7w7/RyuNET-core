import { Router, json, urlencoded } from 'express';
import {
  GetProfiles,
  Count,
  FindCardsByRefid,
  FindUserByCardNumber,
  PurgeProfile,
  FindProfile,
  FindCard,
  DeleteCard,
  CreateCard,
  UpdateProfile,
} from '../../utils/EamuseIO';
import { wrap, adminMiddleware } from '../shared/middleware';
import { data, userOwnsProfile } from '../shared/helpers';

export const profileRouter = Router();

profileRouter.get(
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

profileRouter.get(
  '/profiles',
  adminMiddleware,
  wrap(async (req, res) => {
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

profileRouter.get(
  '/profile/:refid',
  wrap(async (req, res, next) => {
    const refid = req.params['refid'];
    const profile = await FindProfile(refid);
    if (!profile) return next();

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

profileRouter.post(
  '/profile/:refid',
  urlencoded({ extended: true, limit: '50mb' }),
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (!req.session.user!.admin && !(await userOwnsProfile(req, refid)))
      return res.sendStatus(403);
    
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

    await UpdateProfile(refid, update);
    req.flash('formOk', 'Updated');
    res.redirect(req.originalUrl);
  })
);

profileRouter.delete(
  '/profile/:refid',
  adminMiddleware,
  wrap(async (req, res) => {
    const refid = req.params['refid'];
    if (await PurgeProfile(refid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

profileRouter.delete(
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
    if (!isAdmin && !isOwner) return res.sendStatus(403);

    if (await DeleteCard(cid)) {
      return res.sendStatus(200);
    } else {
      return res.sendStatus(404);
    }
  })
);

profileRouter.post(
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
      if (!(await FindCard(normalized))) {
        await CreateCard(normalized, refid, normalized);
      }
    }
    res.sendStatus(200);
  })
);
