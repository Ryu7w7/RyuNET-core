import { randomBytes } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFile,
  readFile,
  readdir,
  unlink,
  WriteFileOptions,
} from 'fs';

import { Logger } from './Logger';
import path from 'path';
import nedb from '@seald-io/nedb';
import { nfc2card } from './CardCipher';
import hashids from 'hashids/cjs';
import bcrypt from 'bcryptjs';
import { NAMES } from './Consts';
import { CONFIG, ARGS } from './ArgConfig';
import { isArray, get, isPlainObject, sortBy } from 'lodash';
import { PluginDetect } from '../eamuse/ExternalPluginLoader';
import { ROOT_CONTAINER } from '../eamuse';
import { promises as fsp } from 'fs';
import prettyBytes from 'pretty-bytes';

const pkg: boolean = (process as any).pkg;
const EXEC_PATH = path.resolve(pkg ? path.dirname(process.argv0) : process.cwd());

export const PLUGIN_PATH = path.join(EXEC_PATH, 'plugins');
export const ASSETS_PATH = path.join(pkg ? __dirname : `../build-env`, 'assets');

export const SAVE_PATH = path.resolve(EXEC_PATH, ARGS.savedata);
const COREDB_FILE = path.join(SAVE_PATH, 'core.db');

const LoadDatabase = async (file: string) => {
  const DB = new nedb({
    filename: file,
    timestampData: true,
    corruptAlertThreshold: ARGS.fixdb ? 0.2 : 0,
  });

  const filename = path.basename(file);
  try {
    await DB.loadDatabaseAsync();
    if (filename != 'core.db') Logger.info(`Database loaded: ${filename}`, { plugin: 'db' });
  } catch (err) {
    if (err) {
      if (err.message && err.message.startsWith('More than')) {
        if (ARGS.fixdb) {
          Logger.error(
            `Savedata "${filename}" is more than 20% corrupted. Which means the savedata might be beyond repair. Please delete the savefile in order to keep using CORE.`
          );
          process.exit(1);
        } else {
          Logger.error(
            `Savedata "${filename}" corruption detected. Run with "--force-load-db" argument to force load data, and corrupted portion will be discarded. It is recommended to backup savedata before force loading.`
          );
          process.exit(1);
        }
      } else {
        Logger.error(`Can not load database "${filename}":`);
        Logger.error(err);
      }
    }
    return null;
  }

  const value = await DB.countAsync({ __s: 'profile' });
  if (value < 0) {
    Logger.error('Profile indexes is corrupted. Can not load database.');
    process.exit(1);
  }

  try {
    await DB.ensureIndexAsync({ fieldName: '__s' });
    await DB.ensureIndexAsync({ fieldName: '__refid' });
  } catch (err) {
    Logger.error(err);
  }

  try {
    await DB.removeAsync({ __s: 'plugins_profile', __refid: { $exists: false } }, { multi: true });
  } catch (err) {
    Logger.error(err);
  }

  return DB;
};

let CoreDB: nedb = null;
export const LoadCoreDB = async () => {
  CoreDB = await LoadDatabase(COREDB_FILE);

  if (!CoreDB) {
    process.exit(1);
  }
};

const DBInstances: { [key: string]: nedb } = {};

const GET_DB = async (affiliation: string) => {
  if (!DBInstances[affiliation]) {
    DBInstances[affiliation] = await LoadDatabase(path.join(SAVE_PATH, `${affiliation}.db`));
    if (!DBInstances[affiliation]) {
      delete DBInstances[affiliation];
      return null;
    }
  }

  return DBInstances[affiliation];
};

const ID_GEN = new hashids('AsphyxiaCORE', 15, '0123456789ABCDEF');

export function PrepareDirectory(dir: string = ''): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return dir;
}

export function ReadAssets(file: string): any {
  let fullFile = path.join(ASSETS_PATH, `${file}`);

  try {
    if (!existsSync(fullFile)) {
      return null;
    }
    const data = readFileSync(fullFile, {
      encoding: 'utf-8',
    });
    return data;
  } catch (err) {
    return null;
  }
}

// =========================================
//                Public IO
// =========================================
export function Resolve(plugin: PluginDetect, file: string) {
  return path.resolve(PLUGIN_PATH, plugin.identifier, file);
}

export async function ReadDir(plugin: PluginDetect, file: string) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  return new Promise<{ name: string; type: 'file' | 'dir' | 'unsupported' }[]>(resolve => {
    readdir(target, { encoding: 'utf8', withFileTypes: true }, (err, files) => {
      if (err) {
        Logger.error(`File writing failed: ${err}`, { plugin });
        return resolve([]);
      }
      resolve(
        files.map(file => ({
          name: file.name,
          type: file.isFile() ? 'file' : file.isDirectory() ? 'dir' : 'unsupported',
        }))
      );
    });
  });
}

export function Exists(plugin: PluginDetect, file: string) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);
  return existsSync(target);
}

export async function WriteFile(
  plugin: PluginDetect,
  file: string,
  data: string | Buffer,
  options: WriteFileOptions
) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  PrepareDirectory(path.dirname(target));

  return new Promise<void>(resolve => {
    if (options == null) {
      writeFile(target, data, err => {
        if (err) {
          Logger.error(`File writing failed: ${err}`, { plugin });
        }
        resolve();
      });
    } else {
      writeFile(target, data, options, err => {
        if (err) {
          Logger.error(`File writing failed: ${err}`, { plugin: plugin });
        }
        resolve();
      });
    }
  });
}

export async function DeleteFile(plugin: PluginDetect, file: string) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  return new Promise<void>(resolve => {
    unlink(target, err => {
      if (err) {
        Logger.error(`File writing failed: ${err}`, { plugin });
      }
      resolve();
    });
  });
}

export async function ReadFile(
  plugin: PluginDetect,
  file: string,
  options: { encoding?: BufferEncoding | null; flag?: string } | BufferEncoding | undefined | null
) {
  const target = path.resolve(PLUGIN_PATH, plugin.identifier, file);

  return new Promise<string | Buffer>(resolve => {
    if (options == null) {
      readFile(target, (err, data) => {
        if (err) {
          Logger.error(`File reading failed: ${err}`, { plugin: plugin });
          return resolve(null);
        }
        return resolve(data);
      });
    } else {
      readFile(target, options, (err, data) => {
        if (err) {
          Logger.error(`File reading failed: ${err}`, { plugin: plugin });
          return resolve(null);
        }
        return resolve(data);
      });
    }
  });
}

// =========================================
//                DB Wrapper
// =========================================

export async function GetUniqueInt() {
  try {
    const doc = await CoreDB.findOneAsync<any>({
      __s: 'counter',
    });
    const result = doc ? doc.value : 0;
    await CoreDB.updateAsync(
      {
        __s: 'counter',
      },
      { $inc: { value: 1 } },
      { upsert: true }
    );
    return result;
  } catch (err) {
    Logger.error(err);
    return -1;
  }
}

export async function PluginStats(): Promise<
  {
    name: string;
    id: string;
    dataSize: string;
    hasData: boolean;
  }[]
> {
  const list = await fsp.readdir(SAVE_PATH);
  const result = [];

  for (const installed of ROOT_CONTAINER.Plugins.map(e => e.Identifier)) {
    if (list.indexOf(`${installed}.db`) < 0) {
      result.push({
        name: installed.split('@')[0].toUpperCase(),
        id: installed,
        dataSize: 'No Data',
        hasData: false,
      });
    }
  }

  for (const savefile of list) {
    if (savefile.startsWith('_') || savefile.startsWith('.') || savefile.startsWith('core')) {
      continue;
    }

    try {
      const filestat = await fsp.stat(path.join(SAVE_PATH, savefile));

      const basename = path.basename(savefile, '.db');
      result.push({
        name: basename.split('@')[0].toUpperCase(),
        id: basename,
        dataSize: prettyBytes(filestat.size),
        hasData: true,
      });
    } catch (err) {
      Logger.error(`Cannot read savefile ${savefile}:`);
      Logger.error(err);
    }
  }

  return sortBy(result, 'id');
}

export async function PurgePlugin(affiliation: string) {
  try {
    if (DBInstances[affiliation]) {
      delete DBInstances[affiliation];
    }
    await fsp.unlink(path.join(SAVE_PATH, `${affiliation}.db`));
  } catch (err) {
    Logger.error(`Cannot delete savefile ${affiliation}.db:`);
    Logger.error(err);
  }
}

export async function Count(doc: any) {
  try {
    return await CoreDB.countAsync(doc);
  } catch (err) {
    Logger.error(err);
    return -1;
  }
}

export async function GetProfileCount() {
  return await Count({ __s: 'profile' });
}

export async function FindCard(cid: string) {
  try {
    return await CoreDB.findOneAsync<any>({ __s: 'card', cid });
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function FindCardsByRefid(refid: string) {
  try {
    return await CoreDB.findAsync<any>({ __s: 'card', __refid: refid })
      .sort({ createdAt: 1 })
      .execAsync();
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function CreateCard(cid: string, refid: string, forcePrint?: string) {
  let print = '<Invalid Card>';

  if (forcePrint) {
    print = forcePrint;
  } else {
    try {
      print = nfc2card(cid);
    } catch (err) {
      print = cid;
    }
  }

  try {
    return await CoreDB.insertAsync<any>({ __s: 'card', __refid: refid, print, cid });
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function DeleteCard(cid: string) {
  try {
    await CoreDB.removeAsync({ __s: 'card', cid }, { multi: true });
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function FindProfile(refid: string) {
  try {
    return await CoreDB.findOneAsync<any>({
      __s: 'profile',
      __refid: refid,
    });
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function CreateProfile(pin: string, gameCode: string) {
  if (!CONFIG.allow_register) return false;

  const count = await GetUniqueInt();
  if (count < 0) return false;

  const refid = 'A' + ID_GEN.encode(count * 16 + Math.floor(Math.random() * 16));
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];

  try {
    return await CoreDB.insertAsync({
      __s: 'profile',
      __refid: refid,
      pin,
      name,
      models: [gameCode],
    });
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function UpdateProfile(refid: string, update: any, upsert: boolean = false) {
  try {
    await CoreDB.updateAsync(
      {
        __s: 'profile',
        __refid: refid,
      },
      {
        $set: update,
      },
      { upsert }
    );
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function PurgeProfile(refid: string) {
  try {
    await CoreDB.removeAsync({ __refid: refid }, { multi: true });
  } catch (err) {
    Logger.error(err);
    return false;
  }

  const list = await fsp.readdir(SAVE_PATH);
  for (const savefile of list) {
    if (savefile.startsWith('_') || savefile.startsWith('.') || savefile.startsWith('core')) {
      continue;
    }

    const affiliation = path.basename(savefile, '.db');

    const DB = await GET_DB(affiliation);
    if (DB) {
      try {
        await DB.removeAsync({ __refid: refid }, { multi: true });
      } catch (err) {
        Logger.error(err);
      }
    }
  }

  return true;
}

export async function BindProfile(refid: string, gameCode: string) {
  try {
    return await CoreDB.updateAsync(
      {
        __s: 'profile',
        __refid: refid,
      },
      { $addToSet: { models: gameCode } }
    );
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

// =========================================
//             User Accounts
// =========================================

export async function SeedDefaultAdmin() {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'user_account', admin: true });
    if (existing) return;

    const hash = await bcrypt.hash('admin', 10);
    await CoreDB.insertAsync({
      __s: 'user_account',
      username: 'admin',
      password: hash,
      cardNumber: '',
      admin: true,
    });
    Logger.info('Default admin account created (username: admin, password: admin)');
  } catch (err) {
    Logger.error(err);
  }
}

export async function CreateUserAccount(
  username: string,
  password: string,
  cardNumber: string,
  admin: boolean = false,
  countryCode: string | null = null
) {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'user_account', username });
    if (existing) return null;

    const hash = await bcrypt.hash(password, 10);
    return await CoreDB.insertAsync({
      __s: 'user_account',
      username,
      password: hash,
      cardNumber,
      admin,
      countryCode,
    });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function AuthenticateUser(username: string, password: string) {
  try {
    const user = await CoreDB.findOneAsync<any>({ __s: 'user_account', username });
    if (!user) return null;

    const match = await bcrypt.compare(password, user.password);
    return match ? user : null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function UpdateUserAccount(
  username: string,
  update: { username?: string; password?: string; countryCode?: string | null }
) {
  try {
    const setFields: any = {};
    if (update.username) setFields.username = update.username;
    if (update.password) setFields.password = await bcrypt.hash(update.password, 10);
    if (update.countryCode !== undefined) setFields.countryCode = update.countryCode;

    await CoreDB.updateAsync({ __s: 'user_account', username }, { $set: setFields });
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetAllUsers(): Promise<any[]> {
  try {
    return await CoreDB.findAsync<any>({ __s: 'user_account' }).sort({ createdAt: 1 }).execAsync();
  } catch (err) {
    Logger.error(err);
    return [];
  }
}

export async function SetUserAdmin(username: string, admin: boolean) {
  try {
    await CoreDB.updateAsync({ __s: 'user_account', username }, { $set: { admin } });
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function FindUserByUsername(username: string) {
  try {
    return await CoreDB.findOneAsync<any>({ __s: 'user_account', username });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function FindUserByCardNumber(cardNumber: string) {
  try {
    return await CoreDB.findOneAsync<any>({ __s: 'user_account', cardNumber });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function SaveTachiToken(username: string, token: string) {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'tachi_token', username });
    if (existing) {
      await CoreDB.updateAsync({ __s: 'tachi_token', username }, { $set: { token } });
    } else {
      await CoreDB.insertAsync({ __s: 'tachi_token', username, token });
    }
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiToken(username: string): Promise<string | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'tachi_token', username });
    return doc ? doc.token : null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function DeleteTachiToken(username: string) {
  try {
    await CoreDB.removeAsync({ __s: 'tachi_token', username }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function SaveTachiExportTimestamp(refid: string, timestamp: number) {
  try {
    const existing = await CoreDB.findOneAsync<any>({ __s: 'tachi_export_ts', refid });
    if (existing) {
      await CoreDB.updateAsync({ __s: 'tachi_export_ts', refid }, { $set: { timestamp } });
    } else {
      await CoreDB.insertAsync({ __s: 'tachi_export_ts', refid, timestamp });
    }
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiExportTimestamp(refid: string): Promise<number | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'tachi_export_ts', refid });
    return doc ? doc.timestamp : null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function SaveTachiAutoExport(refid: string, enabled: boolean) {
  try {
    await CoreDB.updateAsync(
      { __s: 'tachi_auto_export', refid },
      { __s: 'tachi_auto_export', refid, enabled },
      { upsert: true }
    );
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiAutoExport(refid: string): Promise<boolean> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'tachi_auto_export', refid });
    return doc ? doc.enabled : false;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetTachiTokenByRefid(refid: string): Promise<string | null> {
  try {
    const cards = await FindCardsByRefid(refid);
    if (!cards || !Array.isArray(cards) || cards.length === 0) return null;
    for (const card of cards) {
      const user = await FindUserByCardNumber(card.cid);
      if (user) {
        const token = await GetTachiToken(user.username);
        if (token) return token;
      }
    }
    return null;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

//             API Tokens
// =========================================

export async function GenerateApiToken(username: string): Promise<string | null> {
  try {
    const token = randomBytes(32).toString('hex');
    const existing = await CoreDB.findOneAsync<any>({ __s: 'api_token', username });
    if (existing) {
      await CoreDB.updateAsync({ __s: 'api_token', username }, { $set: { token } });
    } else {
      await CoreDB.insertAsync({ __s: 'api_token', username, token });
    }
    return token;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetApiTokenByToken(
  token: string
): Promise<{ username: string; cardNumber: string; admin: boolean } | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'api_token', token });
    if (!doc) return null;
    const user = await FindUserByUsername(doc.username);
    if (!user) return null;
    return { username: user.username, cardNumber: user.cardNumber, admin: user.admin };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetApiTokenExists(username: string): Promise<boolean> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'api_token', username });
    return !!doc;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function DeleteApiToken(username: string): Promise<boolean> {
  try {
    await CoreDB.removeAsync({ __s: 'api_token', username }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

// =========================================
//             OAuth Provider
// =========================================

export async function CreateOAuthClient(
  name: string,
  redirectUri: string,
  createdBy: string
): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const clientId = randomBytes(16).toString('hex');
    const clientSecret = randomBytes(32).toString('hex');
    await CoreDB.insertAsync({
      __s: 'oauth_client',
      clientId,
      clientSecret,
      name,
      redirectUri,
      createdBy,
    });
    return { clientId, clientSecret };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetOAuthClient(clientId: string) {
  try {
    return await CoreDB.findOneAsync<any>({ __s: 'oauth_client', clientId });
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetOAuthClientsByUser(username: string): Promise<any[]> {
  try {
    return await CoreDB.findAsync<any>({ __s: 'oauth_client', createdBy: username });
  } catch (err) {
    Logger.error(err);
    return [];
  }
}

export async function DeleteOAuthClient(clientId: string, username: string): Promise<boolean> {
  try {
    // Also clean up any tokens and codes issued for this client
    await CoreDB.removeAsync({ __s: 'oauth_code', clientId }, { multi: true });
    await CoreDB.removeAsync({ __s: 'oauth_access_token', clientId }, { multi: true });
    await CoreDB.removeAsync({ __s: 'oauth_client', clientId, createdBy: username }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function CreateOAuthCode(
  clientId: string,
  username: string,
  redirectUri: string,
  scopes: string[]
): Promise<string | null> {
  try {
    const code = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    await CoreDB.insertAsync({
      __s: 'oauth_code',
      code,
      clientId,
      username,
      redirectUri,
      scopes,
      expiresAt,
    });
    return code;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function ConsumeOAuthCode(code: string) {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'oauth_code', code });
    if (!doc) return null;
    await CoreDB.removeAsync({ __s: 'oauth_code', code }, {});
    if (doc.expiresAt < Date.now()) return null;
    return doc;
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function CreateOAuthAccessToken(
  clientId: string,
  username: string,
  scopes: string[]
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const accessToken = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    await CoreDB.insertAsync({
      __s: 'oauth_access_token',
      accessToken,
      refreshToken,
      clientId,
      username,
      scopes,
      expiresAt,
    });
    return { accessToken, refreshToken };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function GetOAuthAccessToken(
  token: string
): Promise<{ username: string; cardNumber: string; admin: boolean; scopes: string[] } | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'oauth_access_token', accessToken: token });
    if (!doc) return null;
    if (doc.expiresAt < Date.now()) {
      await CoreDB.removeAsync({ __s: 'oauth_access_token', accessToken: token }, {});
      return null;
    }
    const user = await FindUserByUsername(doc.username);
    if (!user) return null;
    return { username: user.username, cardNumber: user.cardNumber, admin: user.admin, scopes: doc.scopes };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function RefreshOAuthAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
  try {
    const doc = await CoreDB.findOneAsync<any>({ __s: 'oauth_access_token', refreshToken });
    if (!doc) return null;

    const newAccessToken = randomBytes(32).toString('hex');
    const newRefreshToken = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;

    await CoreDB.updateAsync(
      { __s: 'oauth_access_token', refreshToken },
      { $set: { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresAt } }
    );
    return { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: 86400 };
  } catch (err) {
    Logger.error(err);
    return null;
  }
}

export async function RevokeOAuthToken(token: string): Promise<boolean> {
  try {
    await CoreDB.removeAsync({ __s: 'oauth_access_token', accessToken: token }, {});
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

export async function GetOAuthTokensByUser(username: string): Promise<any[]> {
  try {
    return await CoreDB.findAsync<any>({ __s: 'oauth_access_token', username });
  } catch (err) {
    Logger.error(err);
    return [];
  }
}

export async function RevokeOAuthTokensByClientForUser(clientId: string, username: string): Promise<boolean> {
  try {
    await CoreDB.removeAsync({ __s: 'oauth_access_token', clientId, username }, { multi: true });
    return true;
  } catch (err) {
    Logger.error(err);
    return false;
  }
}


export async function GetProfiles() {
  try {
    return (await CoreDB.findAsync<any>({
      __s: 'profile',
    })
      .sort({ createdAt: 1 })
      .execAsync()) as any[];
  } catch (err) {
    Logger.error(err);
    return false;
  }
}

// Public API
function CheckQuery(query: any): any {
  const sanitized: any = {};
  if (isPlainObject(query)) {
    for (const key in query) {
      if (key == '__refid') continue; // ignore __refid
      if (key.startsWith('__')) throw new Error('query or doc field can not starts with "__"');

      sanitized[key] = CheckQuery(query[key]);
    }
    return sanitized;
  } else {
    return query;
  }
}

function CleanDoc(doc: any) {
  if (Array.isArray(doc)) {
    for (const item of doc) {
      CleanDoc(item);
    }
  } else {
    for (const prop in doc) {
      if (prop.startsWith('__') && prop != '__refid') {
        delete doc[prop];
      }
    }
  }
  return doc;
}

export async function APIFindOne(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;

  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid FindOne query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const result = await DB.findOneAsync(query, {});
  return plugin.core ? result : CleanDoc(result);
}

export async function APIFind(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Find query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const result = await DB.findAsync<any>(query, {}).sort({ createdAt: 1 }).execAsync();
  return plugin.core ? result : (CleanDoc(result) as any[]);
}

export async function APIInsert(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let doc: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    if (!plugin.core) {
      const profile = await FindProfile(arg1);
      if (profile == null) {
        Logger.warn('refid does not exists, insert operation canceled', {
          plugin: plugin.identifier,
        });
        return null;
      }
    }
    doc = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    throw new Error('refid must be specified for Insert Query');
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    doc = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Insert query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const result = await DB.insertAsync<any>(doc);
  return plugin.core ? result : CleanDoc(result);
}

export async function APIUpdate(plugin: PluginDetect, arg1: string | any, arg2: any, arg3?: any) {
  let query: any = null;
  let update: any = null;
  let signature: any = {};
  if (typeof arg1 == 'string' && typeof arg2 == 'object' && typeof arg3 == 'object') {
    arg2 = CheckQuery(arg2);
    arg3 = CheckQuery(arg3);
    query = arg2;
    update = arg3;
    signature.__s = 'plugins_profile';
    signature.__refid = arg1;
  } else if (arg1 == null && typeof arg2 == 'object' && typeof arg3 == 'object') {
    arg2 = CheckQuery(arg2);
    arg3 = CheckQuery(arg3);
    query = arg2;
    update = arg3;
    signature.__s = 'plugins_profile';
  } else if (typeof arg1 == 'object' && typeof arg2 == 'object') {
    arg1 = CheckQuery(arg1);
    arg2 = CheckQuery(arg2);
    query = arg1;
    update = arg2;
    signature.__s = 'plugins';
  } else {
    throw new Error('invalid Update query');
  }

  query = { ...query, ...signature };

  if (!get(Object.keys(update), '0', '').startsWith('$')) {
    update = {
      ...update,
      ...signature,
    };
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const docs = await DB.updateAsync<any>(query, update, {
    upsert: false,
    multi: true,
    returnUpdatedDocs: true,
  });

  return {
    updated: (docs as any).length,
    docs: isArray(docs)
      ? docs.map(d => (plugin.core ? d : CleanDoc(d)))
      : [plugin.core ? docs : CleanDoc(docs)],
  };
}

export async function APIUpsert(plugin: PluginDetect, arg1: string | any, arg2: any, arg3?: any) {
  let query: any = null;
  let update: any = null;
  let signature: any = {};
  if (typeof arg1 == 'string' && typeof arg2 == 'object' && typeof arg3 == 'object') {
    arg2 = CheckQuery(arg2);
    arg3 = CheckQuery(arg3);
    if (!plugin.core) {
      const profile = await FindProfile(arg1);
      if (profile == null) {
        Logger.warn('refid does not exists, upsert operation canceled', {
          plugin: plugin.identifier,
        });
        return { updated: 0, docs: [], upsert: false };
      }
    }
    query = arg2;
    update = arg3;
    signature.__s = 'plugins_profile';
    signature.__refid = arg1;
  } else if (arg1 == null && typeof arg2 == 'object') {
    throw new Error('refid must be specified for Upsert Query');
  } else if (typeof arg1 == 'object' && typeof arg2 == 'object') {
    arg1 = CheckQuery(arg1);
    arg2 = CheckQuery(arg2);
    query = arg1;
    update = arg2;
    signature.__s = 'plugins';
  } else {
    throw new Error('invalid Upsert query');
  }

  query = { ...query, ...signature };

  if (!get(Object.keys(update), '0', '').startsWith('$')) {
    update = {
      ...update,
      ...signature,
    };
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  const docs = await DB.updateAsync<any>(query, update, {
    upsert: true,
    multi: true,
    returnUpdatedDocs: true,
  });

  return {
    updated: (docs as any).length,
    docs: isArray(docs)
      ? docs.map(d => (plugin.core ? d : CleanDoc(d)))
      : [plugin.core ? docs : CleanDoc(docs)],
    upsert: true,
  };
}

export async function APIRemove(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Remove query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  return await DB.removeAsync(query, { multi: true });
}

export async function APICount(plugin: PluginDetect, arg1: string | any, arg2?: any) {
  let query: any = null;
  if (typeof arg1 == 'string' && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
      __refid: arg1,
    };
  } else if (arg1 == null && typeof arg2 == 'object') {
    arg2 = CheckQuery(arg2);
    query = {
      ...arg2,
      __s: 'plugins_profile',
    };
  } else if (typeof arg1 == 'object') {
    arg1 = CheckQuery(arg1);
    query = {
      ...arg1,
      __s: 'plugins',
    };
  } else {
    throw new Error('invalid Count query');
  }

  const DB = await GET_DB(plugin.identifier);
  if (!DB) throw new Error(`database failed to load`);

  return await DB.countAsync(query);
}
