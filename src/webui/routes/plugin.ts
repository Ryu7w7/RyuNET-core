import { Router } from 'express';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { sizeof } from 'sizeof';
import { groupBy, startCase } from 'lodash';
import {
  PLUGIN_PATH,
  APIFind,
  PurgeProfile,
  FindProfile,
  APIRemove,
} from '../../utils/EamuseIO';
import { ROOT_CONTAINER } from '../../eamuse/index';
import { wrap, adminMiddleware } from '../shared/middleware';
import { data, ConfigData, DataFileCheck, userOwnsProfile } from '../shared/helpers';
import { Converter } from 'showdown';

export const pluginRouter = Router();

const markdown = new Converter({
  headerLevelStart: 3,
  strikethrough: true,
  tables: true,
  tasklists: true,
});

pluginRouter.get(
  '/:plugin',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);
    if (!plugin) return next();

    const readmePath = path.join(PLUGIN_PATH, plugin.Identifier, 'README.md');
    let readme = null;
    try {
      if (existsSync(readmePath)) {
        readme = markdown.makeHtml(readFileSync(readmePath, { encoding: 'utf-8' }));
      }
    } catch { readme = null; }

    res.render(
      'plugin',
      data(req, plugin.Name, plugin.Identifier, {
        readme,
        config: ConfigData(plugin.Identifier),
        datafile: DataFileCheck(plugin.Identifier),
        contributors: plugin.Contributors,
        gameCodes: plugin.GameCodes,
        subtitle: 'Overview',
        subidentifier: 'overview',
      })
    );
  })
);

pluginRouter.get(
  '/:plugin/profiles',
  adminMiddleware,
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);
    if (!plugin) return next();

    const profiles = groupBy(
      await APIFind({ identifier: plugin.Identifier, core: true }, null, {}),
      '__refid'
    );

    const profileData: any[] = [];
    for (const refid in profiles) {
      let name = undefined;
      for (const doc of profiles[refid]) {
        if (doc.__refid == null) {
          PurgeProfile(doc.__refid);
          break;
        }
        if (typeof doc.name == 'string') {
          name = doc.name;
          break;
        }
      }

      profileData.push({
        refid,
        name,
        dataSize: sizeof(profiles[refid], true),
        coreProfile: await FindProfile(refid),
        isOwner: await userOwnsProfile(req, refid),
      });
    }

    res.render(
      'plugin_profiles',
      data(req, plugin.Name, plugin.Identifier, {
        subtitle: 'Profiles',
        subidentifier: 'profiles',
        hasCustomPage: plugin.FirstProfilePage != null,
        profiles: profileData,
        isAdmin: true,
      })
    );
  })
);

pluginRouter.get(
  '/:plugin/profile',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);
    const refid = req.query['refid'];
    if (!plugin || !refid) return next();

    const pageName = req.query['page'];
    const page = pageName ? `profile_${pageName}` : plugin.FirstProfilePage;
    if (!page) return next();

    const isAdmin = req.session.user!.admin;
    const isOwner = await userOwnsProfile(req, refid.toString());
    const ownerOnlyPages = ['profile_tachi', 'profile_nabla', 'profile_migrate'];
    if (ownerOnlyPages.includes(page) && !isAdmin && !isOwner) {
      return res.redirect(`/plugin/${req.params['plugin']}/profile?refid=${refid}`);
    }

    const content = await plugin.render(page, { query: req.query }, refid.toString());
    if (content == null) return next();

    const tabs = plugin.ProfilePages.filter(p => !ownerOnlyPages.includes(p) || isAdmin || isOwner).map(p => ({
      name: startCase(p.substr(8)),
      link: p.substr(8),
    }));

    res.render(
      'custom_profile',
      data(req, plugin.Name, plugin.Identifier, {
        content, tabs, subtitle: 'Profiles', subidentifier: 'profiles',
        subsubtitle: startCase(page.substr(8)), subsubidentifier: page.substr(8),
        refid: refid.toString(), isAdmin, isOwner,
      })
    );
  })
);

pluginRouter.get(
  '/:plugin/static/*',
  wrap(async (req, res, next) => {
    const dataPath = req.params[0];
    if (dataPath.startsWith('.')) return next();

    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);
    if (!plugin) return next();

    const file = path.join(PLUGIN_PATH, plugin.Identifier, 'webui', dataPath);
    res.sendFile(file, {}, err => { if (err) next(); });
  })
);

pluginRouter.get(
  '/:plugin/:page',
  wrap(async (req, res, next) => {
    const plugin = ROOT_CONTAINER.getPluginByID(req.params['plugin']);
    const pageName = req.params['page'];
    if (!plugin) return next();

    const ADMIN_ONLY_PAGES = ['startup flags', 'unlock events', 'update webui assets', 'weekly score attack'];
    if (ADMIN_ONLY_PAGES.includes(pageName) && !req.session.user!.admin) {
      return res.redirect('/');
    }

    const content = await plugin.render(pageName, { query: req.query });
    if (content == null) return next();

    res.render(
      'custom',
      data(req, plugin.Name, plugin.Identifier, {
        content, subtitle: startCase(pageName), subidentifier: pageName,
      })
    );
  })
);
