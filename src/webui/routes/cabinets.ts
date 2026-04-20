import { Router } from 'express';
import { urlencoded } from 'body-parser';
import {
  CreateCabinet,
  GetCabinetsByUser,
  DeleteCabinet,
  GetCabinetByPCBID,
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
    const cabinets = await GetCabinetsByUser(req.session.user.username);
    res.render(
      'cabinets',
      data(req, 'Cabinets', 'core', {
        cabinets: cabinets.map((c: any) => ({
          pcbid: c.pcbid,
          name: c.name,
          globalPort: c.globalPort,
          lastSeen: c.lastSeen,
        })),
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

    const { name } = req.body;
    if (!name || name.trim() === '') {
      req.flash('cabinetError', 'Name is required');
      return res.redirect('/cabinets');
    }

    if (!req.session.user.admin) {
      const cabinets = await GetCabinetsByUser(req.session.user.username);
      if (cabinets.length >= 10) {
        req.flash('cabinetError', 'You have reached the maximum limit of 10 cabinets.');
        return res.redirect('/cabinets');
      }
    }

    const pcbid = await CreateCabinet(req.session.user.username, name.trim());
    if (!pcbid) {
      req.flash('cabinetError', 'Failed to create cabinet');
    } else {
      req.flash('cabinetSuccess', 'Cabinet created successfully!');
    }

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
