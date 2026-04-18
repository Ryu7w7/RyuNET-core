import { RequestHandler } from 'express';
import { GetApiTokenByToken, GetOAuthAccessToken } from '../../utils/EamuseIO';

// Simple wrapper for async express handlers to catch errors and pass them to next()
export const wrap =
  (fn: RequestHandler) =>
    (...args: any[]) =>
      (fn as any)(...args).catch(args[2]);

// Authentication middleware to ensure only logged-in users can access certain routes
export const authMiddleware: RequestHandler = (req, res, next) => {
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

  if (!req.session.user) return res.redirect('/login');
  if (!req.session.user) return res.redirect('/login');
  next();
};

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
