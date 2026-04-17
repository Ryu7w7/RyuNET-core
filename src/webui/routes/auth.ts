import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import http from 'http';
import {
  AuthenticateUser,
  UpdateUserAccount,
  CreateUserAccount,
  FindCard,
  FindCardsByRefid,
  FindUserByCardNumber,
  UpdateProfile,
} from '../../utils/EamuseIO';
import { wrap } from '../shared/middleware';

export const authRouter = Router();

// Rate limiting for auth routes to prevent brute-force
const authLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per window
  message: 'Too many login/signup attempts from this IP, please try again after 15 minutes',
});

// Simple in-memory cache for IP country lookups (expires after 1 hour)
const ipCache = new Map<string, { country: string; timestamp: number }>();
const CACHE_TTL = 60 * 60 * 1000;

async function getCountryByIp(ip: any): Promise<string | null> {
  const ipStr = typeof ip === 'string' ? ip.split(',')[0].trim() : ip?.[0];
  if (!ipStr || ipStr === '127.0.0.1' || ipStr === '::1') return null;

  const cached = ipCache.get(ipStr);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.country;
  }

  try {
    const country = await new Promise<string | null>((resolve) => {
      const apiReq = http.get(`http://ip-api.com/json/${ipStr}?fields=countryCode`, (apiRes: any) => {
        let data = '';
        apiRes.on('data', (c: string) => (data += c));
        apiRes.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.countryCode || null);
          } catch {
            resolve(null);
          }
        });
      }).on('error', () => resolve(null));
      apiReq.setTimeout(2000, () => {
        apiReq.destroy();
        resolve(null);
      });
    });

    if (country) {
      ipCache.set(ipStr, { country, timestamp: Date.now() });
    }
    return country;
  } catch {
    return null;
  }
}

authRouter.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.admin ? '/' : '/about');
  res.render('login', { error: req.flash('authError')[0] || null });
});

authRouter.post(
  '/login',
  authLimit,
  wrap(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      req.flash('authError', 'Please fill in all fields.');
      return res.redirect('/login');
    }

    const user = await AuthenticateUser(username, password);
    if (!user) {
      req.flash('authError', 'Invalid username or password.');
      return res.redirect('/login');
    }

    // Auto-update country if missing
    if (!user.countryCode || user.countryCode === 'xx') {
      const country = await getCountryByIp(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
      if (country) {
        await UpdateUserAccount(user.username, { countryCode: country });
        user.countryCode = country;
      }
    }

    req.session.user = {
      username: user.username,
      cardNumber: user.cardNumber,
      admin: user.admin || false,
    };
    res.redirect(user.admin ? '/' : '/about');
  })
);

authRouter.get('/signup', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.admin ? '/' : '/about');
  res.render('signup', { error: req.flash('authError')[0] || null, old: {} });
});

authRouter.post(
  '/signup',
  authLimit,
  wrap(async (req, res) => {
    const { username, password, confirmPassword, cardNumber } = req.body;
    const old = { username, cardNumber, password, confirmPassword };

    if (!username || !password || !confirmPassword || !cardNumber) {
      return res.render('signup', { error: 'Please fill in all fields.', old });
    }

    if (password !== confirmPassword) {
      return res.render('signup', { error: 'Passwords do not match.', old });
    }

    if (username.length < 3) {
      return res.render('signup', { error: 'Username must be at least 3 characters.', old });
    }

    if (password.length < 4) {
      return res.render('signup', { error: 'Password must be at least 4 characters.', old });
    }

    const normalized = cardNumber.replace(/[\s\-]/g, '').toUpperCase();
    let nfcId: string;
    if (/^[0-9A-F]{16}$/.test(normalized)) {
      nfcId = normalized;
    } else {
      return res.render('signup', {
        error: 'Invalid card number format. Must be a 16-character hex string.',
        old,
      });
    }

    const card = await FindCard(nfcId);
    if (!card) {
      return res.render('signup', {
        error: 'Card number not found. You must have a registered card to sign up.',
        old,
      });
    }

    if (card.__refid) {
      const profileCards = await FindCardsByRefid(card.__refid);
      if (profileCards && Array.isArray(profileCards)) {
        for (const c of profileCards) {
          const owner = await FindUserByCardNumber(c.cid);
          if (owner) {
            return res.render('signup', {
              error: 'This card number is already registered to an account.',
              old,
            });
          }
        }
      }
    } else {
      const existingAccount = await FindUserByCardNumber(nfcId);
      if (existingAccount) {
        return res.render('signup', {
          error: 'This card number is already registered to an account.',
          old,
        });
      }
    }

    const countryCode = await getCountryByIp(req.headers['x-forwarded-for'] || req.socket.remoteAddress);

    const account = await CreateUserAccount(username, password, nfcId, false, countryCode);
    if (!account) {
      return res.render('signup', { error: 'Username already exists.', old });
    }

    if (card.__refid) {
      await UpdateProfile(card.__refid, { name: username });
    }

    req.session.user = { username, cardNumber: nfcId, admin: false };
    res.redirect('/about');
  })
);

authRouter.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});
