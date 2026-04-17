import { Request } from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { get, lowerCase, upperFirst, startCase } from 'lodash';
import { VERSION } from '../../utils/Consts';
import {
  CONFIG_MAP,
  CONFIG_DATA,
  CONFIG,
  CONFIG_OPTIONS,
  ARGS,
  DATAFILE_MAP,
  FILE_CHECK,
} from '../../utils/ArgConfig';
import {
  PLUGIN_PATH,
  GetProfileCount,
  FindProfile,
  FindCardsByRefid,
  FindCard,
} from '../../utils/EamuseIO';
import { ROOT_CONTAINER } from '../../eamuse/index';

const ADMIN_ONLY_PAGES = [
  'startup flags',
  'unlock events',
  'update webui assets',
  'weekly score attack',
];

export async function userOwnsProfile(req: Request, refid: string): Promise<boolean> {
  if (!req.session.user) return false;
  const cardNumber = req.session.user.cardNumber;
  if (!cardNumber) return false;
  const cards = await FindCardsByRefid(refid);
  if (!cards || !Array.isArray(cards)) return false;
  return cards.some((c: any) => c.cid === cardNumber || c.print === cardNumber);
}

export function data(req: Request, title: string, plugin: string, attr?: any) {
  const formOk = req.flash('formOk');
  const formWarn = req.flash('formWarn');
  const aside = req.cookies.asidemenu == 'true';

  let formMessage = null;
  if (formOk.length > 0) {
    formMessage = { danger: false, message: formOk.join(' ') };
  } else if (formWarn.length > 0) {
    formMessage = { danger: true, message: formWarn.join(' ') };
  }

  return {
    title,
    aside,
    plugin,
    local: req.ip == '127.0.0.1' || req.ip == '::1',
    version: VERSION,
    user: req.session.user ? req.session.user.username : null,
    admin: req.session.user ? req.session.user.admin : false,
    formMessage,
    plugins: ROOT_CONTAINER.Plugins.map(p => {
      return {
        name: p.Name,
        id: p.Identifier,
        webOnly: p.GameCodes.length == 0,
        pages: p.Pages.filter(f => req.session.user?.admin || !ADMIN_ONLY_PAGES.includes(f)).map(
          f => ({ name: startCase(f), link: f })
        ),
      };
    }),
    ...attr,
  };
}

export function validate(c: CONFIG_OPTIONS, current: any) {
  if (c.validator) {
    const msg = c.validator(current);
    if (typeof msg == 'string') {
      return msg.length == 0 ? 'Invalid value' : msg;
    }
  }

  if (c.range) {
    if (c.type == 'float' || c.type == 'integer') {
      if (current < c.range[0] || current > c.range[1]) {
        return `Value must be in between ${c.range[0]} and ${c.range[1]}.`;
      }
    }
  }

  if (c.options) {
    if (c.type == 'string') {
      if (c.options.indexOf(current) < 0) {
        return `Please select an option.`;
      }
    }
  }

  return null;
}

export function ConfigData(plugin: string) {
  const config: CONFIG_DATA[] = [];
  const configMap = CONFIG_MAP[plugin];
  const configData = plugin == 'core' ? CONFIG : CONFIG[plugin];

  if (!configMap || !configData) {
    return [];
  }

  if (configMap) {
    for (const [key, c] of configMap) {
      const name = get(c, 'name', upperFirst(lowerCase(key)));
      const current = get(configData, key, c.default);
      let error = validate(c, current);

      config.push({
        key,
        ...c,
        current,
        name,
        error,
      });
    }
  }
  return config;
}

export function DataFileCheck(plugin: string) {
  const files: FILE_CHECK[] = [];
  const fileMap = DATAFILE_MAP[plugin];

  if (!fileMap) {
    return [];
  }

  for (const [filepath, c] of fileMap) {
    const target = path.resolve(PLUGIN_PATH, plugin, filepath);
    const filename = path.basename(target);
    const uploaded = existsSync(target);
    const config = { ...c };
    if (!c.name) {
      config.name = filename;
    }
    files.push({ ...config, path: filepath, uploaded, filename });
  }

  return files;
}
