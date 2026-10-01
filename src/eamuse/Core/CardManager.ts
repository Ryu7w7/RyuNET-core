import { EamuseRouteContainer } from '../EamuseRouteContainer';
import { get } from 'lodash';
import { ROOT_CONTAINER } from '../index';
import {
  FindCard,
  FindProfile,
  CreateProfile,
  BindProfile,
  DeleteCard,
  CreateCard,
  UpdateProfile,
  APIFindOne,
  FindUserByCardNumber,
  UpdateUserAccount,
  GetCabinetByPCBID,
  FindUserByUsername,
} from '../../utils/EamuseIO';

export const cardmng = new EamuseRouteContainer();

// 8-digit zero-padded code derived from the refid (standard eamuse pcode).
// Must stay a string: numeric serialization would drop leading zeros.
function pcode(refid: string): string {
  try {
    const v = parseInt((refid || '').slice(0, 8), 16);
    if (!isNaN(v)) return String(v % 100000000).padStart(8, '0');
  } catch {}
  return '00000000';
}

async function inquireAttrs(refid: string, gameCode: string) {
  return {
    binded: (await CheckProfile(gameCode, refid)) ? 1 : 0,
    dataid: refid,
    ecflag: 1,
    expired: 0,
    newflag: 0,
    pcode: pcode(refid),
    refid,
  };
}

async function CheckProfile(gameCode: string, refid: string) {
  const plugin = ROOT_CONTAINER.getPluginByCode(gameCode);
  if (!plugin) {
    return false;
  }
  const profile = await APIFindOne({ identifier: plugin.Identifier, core: true }, refid, {});
  if (profile != null) {
    return true;
  }
  return false;
}

cardmng.add('cardmng.inquire', async (info, data, send) => {
  const cid: string = get(data, '@attr.cardid');

  // let refid = CARD_CACHE[cid];

  let card = await FindCard(cid);

  // Self-heal: cards provisioned before numeric refids (A+hex, e.g. from the
  // first XIF test session) are rejected by the XIF client outright
  // (ThrowIfInvalidRefId). Drop and re-provision them as numeric.
  if (card && info.gameCode === 'XIF' && !/^[0-9]{16}$/.test(card.__refid || '')) {
    await DeleteCard(cid);
    card = await FindCard(cid);
  }

  if (!card) {
    // XIF (EA3 Unity card service) decides new-card vs repeater from the
    // NATIVE header (Status=-18/StatusCode=112), which the HTTP transport
    // always reports as success — so a 112 here surfaces client-side as
    // INSUFFICIENT NODE instead of the NewCard flow. Auto-provision the
    // card instead; the game finishes binding via bindmodel/getrefid.
    // Other games keep the legacy 112 (they read the module status).
    if (info.gameCode === 'XIF') {
      const created = await provisionCard(cid, info.gameCode);
      if (created) {
        return send.object({
          '@attr': {
            ...(await inquireAttrs(created, info.gameCode)),
            lastupdate: Math.floor(Date.now() / 1000),
          },
        });
      }
    }
    // Create new account
    return send.status(112);
  }

  const profile = await FindProfile(card.__refid);
  if (!profile) {
    if (info.gameCode === 'XIF') {
      await DeleteCard(cid);
      const created = await provisionCard(cid, info.gameCode);
      if (created) {
        return send.object({
          '@attr': {
            ...(await inquireAttrs(created, info.gameCode)),
            lastupdate: Math.floor(Date.now() / 1000),
          },
        });
      }
    } else {
      await DeleteCard(cid);
    }
    return send.status(112);
  }

  if (profile.pin === 'unset') {
    // XIF: same native-header limitation as above — let it through, the PIN
    // is (re)set via getrefid and authpass accepts anything over HTTP.
    if (info.gameCode !== 'XIF') {
      // need update pin
      return send.status(112);
    }
  }

  // Identify Country asynchronously based on IP address
  if (info.ip && info.ip !== '127.0.0.1' && info.ip !== '::1') {
    Promise.resolve().then(async () => {
      try {
        const http = require('http');
        const apiReq = http.get(`http://ip-api.com/json/${info.ip}?fields=countryCode`, (apiRes: any) => {
          let reqData = '';
          apiRes.on('data', (c: string) => reqData += c);
          apiRes.on('end', async () => {
            try {
              const parsed = JSON.parse(reqData);
              const countryCode = parsed.countryCode;
              
              if (countryCode) {
                // Determine if we need to update profile
                if (!profile.countryCode || profile.countryCode.toLowerCase() === 'xx' || profile.countryCode !== countryCode) {
                  await UpdateProfile(profile.__refid, { countryCode });
                }

                // Sync with WebUI UserAccount if registered
                const user = await FindUserByCardNumber(cid);
                if (user && (!user.countryCode || user.countryCode.toLowerCase() === 'xx' || user.countryCode !== countryCode)) {
                  await UpdateUserAccount(user.username, { countryCode });
                }
              }
            } catch (ignored) {}
          });
        }).on('error', () => {});
        apiReq.setTimeout(2000, () => { apiReq.destroy(); });
      } catch (ignored) {}
    });
  }

  send.object({
    '@attr': {
      ...(await inquireAttrs(card.__refid, info.gameCode)),
      lastupdate: card.updatedAt
        ? Math.floor(new Date(card.updatedAt).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
    },
  });

  return;
});

// Provision a fresh card+profile pair (mirrors the getrefid create branch).
// XIF needs a 16-digit numeric refid (its client rejects A+hex), so generate
// one and check it against the DB. Returns the new refid, or null.
async function provisionCard(cid: string, gameCode: string): Promise<string | null> {
  let refid: string | undefined;
  if (gameCode === 'XIF') {
    for (let i = 0; i < 25; i++) {
      let s = String(1 + Math.floor(Math.random() * 9));
      for (let k = 1; k < 16; k++) s += String(Math.floor(Math.random() * 10));
      if (!(await FindProfile(s))) {
        refid = s;
        break;
      }
    }
    if (!refid) return null;
  }
  const newProfile = await CreateProfile('0000', gameCode, refid);
  if (!newProfile) return null;
  const created = newProfile.__refid;
  const newCard = await CreateCard(cid, created);
  if (!newCard) return null;
  return created;
}

cardmng.add('cardmng.getrefid', async (info, data, send) => {
  const cid: string = get(data, '@attr.cardid');
  const pin: string = get(data, '@attr.passwd');

  const card = await FindCard(cid);
  if (card) {
    // Card exists, update profile pin
    const updated = await UpdateProfile(card.__refid, { pin }, true);
    if (updated) {
      await BindProfile(card.__refid, info.gameCode);
      return send.object({
        '@attr': { dataid: card.__refid, refid: card.__refid, pcode: pcode(card.__refid) },
      });
    } else {
      return send.deny();
    }
  }

  const newProfile = await CreateProfile(pin, info.gameCode);
  if (!newProfile) {
    // Creation Failed
    return send.deny();
  }

  const refid = newProfile.__refid;

  const newCard = await CreateCard(cid, refid);
  if (!newCard) {
    // Creation Failed
    return send.deny();
  }

  if (info.pcbid) {
    const cabinet = await GetCabinetByPCBID(info.pcbid);
    if (cabinet && cabinet.username) {
      const user = await FindUserByUsername(cabinet.username);
      if (user && (!user.cardNumber || user.cardNumber === '')) {
        await UpdateUserAccount(user.username, { cardNumber: cid });
      }
    }
  }

  send.object({ '@attr': { dataid: refid, refid, pcode: pcode(refid) } });
  return;
});

cardmng.add('cardmng.authpass', async (info, data, send) => {
  const refid = get(data, '@attr.refid', null);
  const pass = get(data, '@attr.pass', '-1');

  const profile = await FindProfile(refid);

  if (!profile) {
    return send.status(110);
  }

  if (info.gameCode === 'XIF') {
    // EA3 Unity reports authpass failures via the NATIVE header, which the
    // HTTP transport cannot carry per-method — and first-login cards are
    // auto-provisioned with a placeholder PIN anyway. Accept the entered
    // PIN and store it, so the DB converges to what the player uses.
    if (profile.pin !== pass) {
      await UpdateProfile(refid, { pin: pass });
    }
    return send.success();
  }

  if (profile.pin !== pass) {
    return send.status(116);
  }

  // Right password
  send.success();
});

cardmng.add('cardmng.bindmodel', async (info, data, send) => {
  const refid = get(data, '@attr.refid', 'DEADC0DEFEEDBEEF');

  await BindProfile(refid, info.gameCode);
  send.object({ '@attr': { dataid: refid } });
});
