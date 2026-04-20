import { Router } from 'express';
import { urlencoded } from 'body-parser';
import {
  CreateCabinet,
  GetCabinetsByUser,
  GetAllCabinets,
  DeleteCabinet,
  GetCabinetByPCBID,
  UpdateCabinet,
  GetAllUsers,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';
import { data } from '../shared/helpers';

export const cabinetsRouter = Router();

cabinetsRouter.get(
  '/cabinets',
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    
    const isAdmin = req.session.user.admin;
    const cabinets = isAdmin 
      ? await GetAllCabinets() 
      : await GetCabinetsByUser(req.session.user.username);
    
    const users = isAdmin ? await GetAllUsers() : [];

    res.render(
      'cabinets',
      data(req, 'Cabinets', 'core', {
        cabinets: cabinets.map((c: any) => ({
          pcbid: c.pcbid,
          name: c.name,
          username: c.username,
          globalPort: c.globalPort,
          lastSeen: c.lastSeen,
        })),
        users: users.map((u: any) => u.username),
        cabinetCount: (await GetCabinetsByUser(req.session.user.username)).length,
        error: req.flash('cabinetError')[0] || null,
        success: req.flash('cabinetSuccess')[0] || null,
      })
    );
  })
);

cabinetsRouter.post(
  '/cabinets/new',
  urlencoded({ extended: true, limit: '1mb' }),
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }

    const { name, targetUsername } = req.body;
    if (!name || name.trim() === '') {
      req.flash('cabinetError', 'Name is required');
      return res.redirect('/cabinets');
    }

    const username = (req.session.user.admin && targetUsername) ? targetUsername : req.session.user.username;

    if (!req.session.user.admin || (targetUsername === req.session.user.username)) {
      const cabinets = await GetCabinetsByUser(username);
      if (cabinets.length >= 10) {
        req.flash('cabinetError', 'Users have a maximum limit of 10 cabinets.');
        return res.redirect('/cabinets');
      }
    }

    const pcbid = await CreateCabinet(username, name.trim());
    if (!pcbid) {
      req.flash('cabinetError', 'Failed to create cabinet');
    } else {
      req.flash('cabinetSuccess', `Cabinet created successfully for ${username}!`);
    }

    res.redirect('/cabinets');
  })
);

cabinetsRouter.post(
  '/cabinets/rename',
  urlencoded({ extended: true, limit: '1mb' }),
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }

    const { pcbid, name } = req.body;
    if (!pcbid || !name || name.trim() === '') {
      req.flash('cabinetError', 'Invalid parameters');
      return res.redirect('/cabinets');
    }

    const cabinet = await GetCabinetByPCBID(pcbid);
    if (!cabinet) {
      req.flash('cabinetError', 'Cabinet not found');
      return res.redirect('/cabinets');
    }

    if (cabinet.username !== req.session.user.username && !req.session.user.admin) {
      req.flash('cabinetError', 'Not authorized to rename this cabinet');
      return res.redirect('/cabinets');
    }

    await UpdateCabinet(pcbid, { name: name.trim() });
    req.flash('cabinetSuccess', 'Cabinet renamed successfully!');
    res.redirect('/cabinets');
  })
);

cabinetsRouter.post(
  '/cabinets/delete',
  urlencoded({ extended: true, limit: '1mb' }),
  wrap(async (req, res) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }

    const { pcbid } = req.body;

    const cabinet = await GetCabinetByPCBID(pcbid);
    if (!cabinet) {
      req.flash('cabinetError', 'Cabinet not found');
      return res.redirect('/cabinets');
    }

    if (cabinet.username !== req.session.user.username && !req.session.user.admin) {
      req.flash('cabinetError', 'Not authorized to delete this cabinet');
      return res.redirect('/cabinets');
    }

    await DeleteCabinet(pcbid, cabinet.username);
    req.flash('cabinetSuccess', 'Cabinet deleted successfully!');
    res.redirect('/cabinets');
  })
);
