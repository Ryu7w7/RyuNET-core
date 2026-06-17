import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { FindCard, FindProfile } from '../../utils/EamuseIO';
import { GET_DB } from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';

export const richPresenceRouter = Router();

/**
 * Strict rate limiter for the Rich Presence lookup endpoint.
 * Prevents bulk scraping while allowing normal RP polling.
 * 30 requests per minute per IP.
 */
const rpLookupLimit = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/rp/lookup?cid=<card_id>
 *
 * Public, read-only endpoint for SDVX Rich Presence name detection.
 * Given a card ID (CID), returns ONLY the in-game profile name and VolForce.
 *
 * Intentionally limited response — no refid, no paseli, no pin, no personal data.
 *
 * Can be disabled via config: rich_presence_lookup = false
 */
richPresenceRouter.get(
  '/api/rp/lookup',
  rpLookupLimit,
  wrap(async (req, res) => {
    const { CONFIG } = require('../../utils/ArgConfig');

    // Allow admin to disable this endpoint via config.ini
    if (CONFIG.rich_presence_lookup === false) {
      return res.status(503).json({ error: 'Rich Presence lookup is disabled on this server.' });
    }

    const rawCid = String(req.query.cid || '').trim();

    // Normalize: uppercase, strip spaces/dashes, O→0, I→1 (same logic as card linking)
    const cid = rawCid
      .toUpperCase()
      .replace(/[\s\-]/g, '')
      .replace(/O/g, '0')
      .replace(/I/g, '1');

    // Must be a valid 16-character hex card ID
    if (!/^[0-9A-F]{16}$/.test(cid)) {
      return res.status(400).json({ error: 'Invalid card ID format. Expected a 16-character hex string.' });
    }

    // Look up the card → profile
    const card = await FindCard(cid);
    if (!card || !card.__refid) {
      return res.status(404).json({ error: 'Card not found.' });
    }

    const profile = await FindProfile(card.__refid);
    if (!profile || !profile.name) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    let totalVolforce = 0;

    try {
      // Load SDVX database to calculate VolForce
      const sdvxDB = await GET_DB('sdvx@asphyxia');
      if (sdvxDB) {
        // Query the player's music records
        const records = await sdvxDB.findAsync({
          __s: 'plugins_profile',
          collection: 'music',
          __refid: card.__refid,
          volforce: { $exists: true }
        });

        if (records && records.length > 0) {
          // Sort by highest volforce descending
          records.sort((a: any, b: any) => (b.volforce || 0) - (a.volforce || 0));
          
          // Sum the top 50 scores
          const top50 = records.slice(0, 50);
          const rawSum = top50.reduce((acc: number, cur: any) => acc + (cur.volforce || 0), 0);
          
          // The game stores volforce as integer (e.g. 19234). We divide by 1000 to get float.
          totalVolforce = rawSum / 1000;
        }
      }
    } catch (err) {
      console.error('Failed to calculate VolForce for RP lookup', err);
    }

    // Return Name and VolForce
    return res.json({ 
      name: profile.name,
      volforce: totalVolforce
    });
  })
);
