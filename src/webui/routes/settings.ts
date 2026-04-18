import { Router, urlencoded, json } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { sizeof } from 'sizeof';
import { groupBy, startCase, isEmpty } from 'lodash';
import {
  CONFIG,
  CONFIG_MAP,
  SaveConfig,
  ARGS,
} from '../../utils/ArgConfig';
import {
  PLUGIN_PATH,
  PluginStats,
  PurgePlugin,
  APIFindOne,
  APIFind,
  APIInsert,
  APIRemove,
  APIUpdate,
  APIUpsert,
  APICount,
  GetProfileCount,
  ReadAssets,
  FindProfile,
  PurgeProfile,
} from '../../utils/EamuseIO';
import { ROOT_CONTAINER } from '../../eamuse/index';
import { wrap, adminMiddleware } from '../shared/middleware';
import { data, ConfigData, DataFileCheck, validate } from '../shared/helpers';
import { VERSION } from '../../utils/Consts';
import { Converter } from 'showdown';
import { Logger } from '../../utils/Logger';

export const settingsRouter = Router();

const markdown = new Converter({
  headerLevelStart: 3,
  strikethrough: true,
  tables: true,
  tasklists: true,
});

settingsRouter.get('/favicon.ico', (_req, res) => {
  res.redirect('/static/favicon.ico');
});

settingsRouter.get(
  '/',
  wrap(async (req, res) => {
    if (!req.session.user?.admin) {
      return res.redirect('/about');
    }

    const memory = `${(process.memoryUsage().rss / 1048576).toFixed(2)}MB`;
    const config = ConfigData('core');
    const changelog = markdown.makeHtml(ReadAssets('changelog.md'));
    const profiles = await GetProfileCount();
    res.render('index', data(req, 'Dashboard', 'core', { memory, config, changelog, profiles }));
  })
);

settingsRouter.get(
  '/about',
  wrap(async (req, res) => {
    const contributors = new Map<string, { name: string; link?: string }>();
    for (const plugin of ROOT_CONTAINER.Plugins) {
      for (const c of plugin.Contributors) {
        contributors.set(c.name, c);
      }
    }
    res.render(
      'about',
      data(req, 'About', 'core', { contributors: Array.from(contributors.values()) })
    );
  })
);

// Data Management
settingsRouter.get(
  '/data',
  adminMiddleware,
  wrap(async (req, res) => {
    const pluginStats = await PluginStats();
    const installed = ROOT_CONTAINER.Plugins.map(p => p.Identifier);
    res.render(
      'data',
      data(req, 'Data Management', 'core', { pluginStats, installed, dev: ARGS.dev })
    );
  })
);

settingsRouter.delete(
  '/data/:plugin',
  adminMiddleware,
  wrap(async (req, res) => {
    const pluginID = req.params['plugin'];
    if (pluginID && pluginID.length > 0) await PurgePlugin(pluginID);

    const plugin = ROOT_CONTAINER.getPluginByID(pluginID);
    if (plugin) {
      try { plugin.Register(); } catch (err) { Logger.error(err, { plugin: pluginID }); }
    }
    res.sendStatus(200);
  })
);

// General setting update
settingsRouter.post(
  ['/', '/plugin/:plugin'],
  urlencoded({ extended: true, limit: '50mb' }),
  wrap(async (req, res, next) => {
    // We don't want to intercept AJAX requests, only direct form posts.
    if (!req.is('application/x-www-form-urlencoded')) return next();

    if (isEmpty(req.body)) return res.sendStatus(400);

    let plugin: string = null;
    if (req.path === '/') {
      plugin = 'core';
    } else if (req.path.startsWith('/plugin/')) {
      plugin = req.params['plugin'];
    }

    if (plugin == null) return res.status(400).send('Invalid settings path');

    const configMap = CONFIG_MAP[plugin];
    const configData = plugin === 'core' ? CONFIG : CONFIG[plugin];

    if (!configMap || !configData) return res.status(404).send('Configuration map not found');

    let needRestart = false;
    for (const [key, config] of configMap) {
      const current = configData[key];
      if (config.type === 'boolean') configData[key] = !!req.body[key];
      if (config.type === 'float') {
        configData[key] = parseFloat(req.body[key]);
        if (isNaN(configData[key])) configData[key] = config.default;
      }
      if (config.type === 'integer') {
        configData[key] = parseInt(req.body[key]);
        if (isNaN(configData[key])) configData[key] = config.default;
      }
      if (config.type === 'string') configData[key] = req.body[key];

      if (current !== configData[key]) {
        if (!validate(config, configData[key]) && config.needRestart) {
          needRestart = true;
        }
      }
    }

    if (needRestart) {
      req.flash('formWarn', 'Some settings require a restart to be applied.');
    } else {
      req.flash('formOk', 'Updated');
    }

    SaveConfig();
    res.redirect(req.originalUrl);
  })
);
