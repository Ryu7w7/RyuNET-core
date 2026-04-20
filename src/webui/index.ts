import { Router } from 'express';
import session from 'express-session';
import cookies from 'cookie-parser';
import createMemoryStore from 'memorystore';
import flash from 'connect-flash';
import { urlencoded } from 'body-parser';
import rateLimit from 'express-rate-limit';

// Module Imports
import { authRouter } from './routes/auth';
import { userRouter } from './routes/user';
import { tachiRouter } from './routes/tachi';
import { profileRouter } from './routes/profile';
import { leaderboardRouter } from './routes/leaderboard';
import { migrationRouter } from './routes/migration';
import { settingsRouter } from './routes/settings';
import { pluginRouter } from './routes/plugin';
import { oauthRouter } from './routes/oauth';
import { nauticaRouter } from './routes/nautica';
import { discordRouter } from './routes/discord';
import { cabinetsRouter } from './routes/cabinets';

// Shared
import { authMiddleware, bearerTokenMiddleware } from './shared/middleware';
import { data } from './shared/helpers';

// Legacy / Component Imports
import { fun } from './fun';
import { ajax as emit } from './emit';

const memorystore = createMemoryStore(session);
export const webui = Router();

// --- Core Middleware Setup ---

webui.use(
  session({
    cookie: { maxAge: 86400000, sameSite: 'lax' },
    proxy: true,
    secret: 'c0dedeadc0debeef',
    resave: false,
    saveUninitialized: true,
    store: new memorystore({ checkPeriod: 86400000 }),
  })
);
webui.use(cookies());

// Redirect Logging (Useful for debugging production loops)
webui.use((req, res, next) => {
  const originalRedirect = res.redirect;
  res.redirect = function (urlOrStatus: any, url?: any): any {
    const targetUrl = typeof urlOrStatus === 'number' ? url : urlOrStatus;
    console.log(`[WebUI] Redirect: ${req.method} ${req.originalUrl} -> ${targetUrl}`);
    return originalRedirect.apply(this, arguments as any);
  };
  next();
});

webui.use(flash());
webui.use(urlencoded({ extended: true, limit: '50mb' }));

// --- Global Rate Limiting ---
const generalLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000, // Limit each IP to 1000 requests per minute
  message: 'Too many requests from this IP, please try again later',
});
webui.use(generalLimit);

// --- Public Routes ---
webui.use(authRouter);
webui.use('/tachi', tachiRouter); // Some Tachi routes are public or handled internally
webui.use(oauthRouter); // OAuth Provider endpoints
webui.use(nauticaRouter); // SDVX Custom Charts / Drive endpoints
webui.use(discordRouter); // Discord login / linking

// --- Protected Routes ---
webui.use(bearerTokenMiddleware);
webui.use(authMiddleware);

webui.use(userRouter);
webui.use(profileRouter);
webui.use(migrationRouter);
webui.use(leaderboardRouter);
webui.use(pluginRouter);
webui.use(cabinetsRouter);

// Dashboard and general settings (handles catch-all POST)
webui.use(settingsRouter);

// Legacy / Specialized
webui.use('/fun', fun);
webui.use('/', emit);

// --- Error Handling ---

// 404
webui.use(async (req, res) => {
  return res.status(404).render('404', data(req, '404 - Are you lost?', 'core'));
});

// 500
webui.use((err: any, req: any, res: any, next: any) => {
  console.error(err);
  if (!res.headersSent) {
    res.status(500).render('500', data(req, '500 - Internal Server Error', 'core', { error: err.message }));
  }
});
