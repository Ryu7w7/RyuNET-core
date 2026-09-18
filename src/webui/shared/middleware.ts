import { RequestHandler } from 'express';
import { GetApiTokenByToken, GetOAuthAccessToken } from '../../utils/EamuseIO';

// Simple wrapper for async express handlers to catch errors and pass them to next()
export const wrap =
  (fn: RequestHandler) =>
    (...args: any[]) =>
      (fn as any)(...args).catch(args[2]);

// ---------------------------------------------------------------------------
// Per-user DB lookup cache — avoids hitting the DB on every authenticated
// request. TTL of 30 seconds: short enough that admin/Discord changes
// propagate quickly, long enough to dramatically reduce DB pressure under load.
// ---------------------------------------------------------------------------
const USER_CACHE_TTL_MS = 30_000;
interface CachedUser { user: any; expiresAt: number; }
const _userCache = new Map<string, CachedUser>();

/** Returns a cached user record or null (if not cached / expired). */
function getCachedUser(username: string): any | null {
  const entry = _userCache.get(username);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _userCache.delete(username);
    return null;
  }
  return entry.user;
}

/** Stores a user record in the cache. Pass null to mark the user as deleted. */
function setCachedUser(username: string, user: any | null): void {
  _userCache.set(username, { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

/** Invalidates a specific user's cache entry (e.g. after an admin action). */
export function invalidateUserCache(username: string): void {
  _userCache.delete(username);
}

// Authentication middleware to ensure only logged-in users can access certain routes
export const authMiddleware: RequestHandler = wrap(async (req, res, next) => {
  const path = req.path.toLowerCase();
  // Public/Asset Whitelist
  if (
    path === '/login' || 
    path === '/signup' || 
    path.startsWith('/help') ||
    path.startsWith('/static') || 
    path === '/favicon.ico' || 
    path.includes('.well-known')
  ) return next();

  if (!req.session.user) {
    // If it's an API/fetch call, return JSON 401 instead of redirecting to HTML login page.
    // This prevents "Unexpected token '<'" errors on the client side.
    const isApiCall =
      req.xhr ||
      (req.headers.accept && req.headers.accept.includes('application/json')) ||
      req.headers['x-requested-with'] === 'XMLHttpRequest' ||
      req.method === 'POST';
    if (isApiCall) return res.status(401).json({ success: false, description: 'Not authenticated' });
    return res.redirect('/login');
  }

  const username = req.session.user.username;

  // Check cache first — avoids a DB query on every authenticated request.
  let dbUser = getCachedUser(username);
  if (dbUser === null) {
    // Cache miss or entry marked-deleted: query the DB.
    const { FindUserByUsername } = require('../../utils/EamuseIO');
    dbUser = await FindUserByUsername(username);
    setCachedUser(username, dbUser ?? null);
  }

  if (dbUser) {
    // Preserve any existing session properties while updating core fields from DB
    req.session.user = {
      ...req.session.user,
      ...dbUser,
      username: dbUser.username,
      cardNumber: dbUser.cardNumber,
      admin: dbUser.admin || false,
    };
  } else {
    // User deleted in DB while session is active
    return res.redirect('/logout');
  }

  next();
});

// Bearer Token middleware to authorize API or OAuth integrations seamlessly
export const bearerTokenMiddleware: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return next();
  
  const token = authHeader.substring(7);

  // Try API token first
  const user = await GetApiTokenByToken(token);
  if (user) {
    req.session.user = {
      username: user.username,
      cardNumber: user.cardNumber,
      admin: user.admin,
    };
    (req as any).isApiAuth = true;
    return next();
  }

  // Try OAuth access token
  const oauthUser = await GetOAuthAccessToken(token);
  if (oauthUser) {
    req.session.user = {
      username: oauthUser.username,
      cardNumber: oauthUser.cardNumber,
      admin: oauthUser.admin,
    };
    (req as any).isApiAuth = true;
    (req as any).oauthScopes = oauthUser.scopes;
    return next();
  }

  return res.status(401).json({ success: false, description: 'Invalid API token or OAuth token' });
};

export const adminMiddleware: RequestHandler = (req, res, next) => {
  if (!req.session.user || !req.session.user.admin) {
    const path = req.path.toLowerCase();
    // Public/Asset Bypass
    if (
      path === '/about' || 
      path.startsWith('/static') || 
      path === '/favicon.ico' || 
      path.includes('.well-known')
    ) return next();
    
    console.log(`[AdminMiddleware] Denied access to ${req.originalUrl}, redirecting to /about`);
    return res.redirect('/about');
  }
  next();
};
