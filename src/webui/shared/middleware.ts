import { RequestHandler } from 'express';

// Simple wrapper for async express handlers to catch errors and pass them to next()
export const wrap =
  (fn: RequestHandler) =>
    (...args: any[]) =>
      (fn as any)(...args).catch(args[2]);

// Authentication middleware to ensure only logged-in users can access certain routes
export const authMiddleware: RequestHandler = (req, res, next) => {
  if (!req.session.user) {
    const path = req.path.toLowerCase();
    if (path === '/login' || path === '/signup' || path.startsWith('/static')) return next();
    return res.redirect('/login');
  }
  next();
};

export const adminMiddleware: RequestHandler = (req, res, next) => {
  if (!req.session.user || !req.session.user.admin) {
    if (req.path.toLowerCase() === '/about') return next();
    return res.redirect('/about');
  }
  next();
};
