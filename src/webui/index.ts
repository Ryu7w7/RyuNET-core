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

// Shared
import { authMiddleware } from './shared/middleware';
import { data } from './shared/helpers';

// Legacy / Component Imports
import { fun } from './fun';
import { ajax as emit } from './emit';

const memorystore = createMemoryStore(session);
export const webui = Router();

// --- Core Middleware Setup ---
webui.use(
  session({
    cookie: { maxAge: 86400000, sameSite: true },
    secret: 'c0dedeadc0debeef',
    resave: true,
    saveUninitialized: false,
    store: new memorystore({ checkPeriod: 86400000 }),
  })
);
webui.use(cookies());
webui.use(flash());
webui.use(urlencoded({ extended: true, limit: '50mb' }));

// --- Global Rate Limiting ---
const generalLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per minute
  message: 'Too many requests from this IP, please try again later',
});
webui.use(generalLimit);

// --- Public Routes ---
webui.use(authRouter);
webui.use('/tachi', tachiRouter); // Some Tachi routes are public or handled internally

// --- Protected Routes ---
webui.use(authMiddleware);

webui.use(userRouter);
webui.use(profileRouter);
webui.use(migrationRouter);
webui.use('/leaderboard', leaderboardRouter);
webui.use('/plugin', pluginRouter);

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
  return res.status(500).render('500', data(req, '500 - Oops', 'core', { err }));
});
