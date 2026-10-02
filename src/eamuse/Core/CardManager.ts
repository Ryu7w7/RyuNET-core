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
  EnsurePhantomProfile,
  APIFindOne,
  FindUserByCardNumber,
  UpdateUserAccount,
  GetCabinetByPCBID,
  FindUserByUsername,
} from '../../utils/EamuseIO';


export const cardmng = new EamuseRouteContainer();

// Game codes that use the EA3 Unity client stack.
// These clients communicate PIN/status via the NATIVE header rather than
// the module-level status code, so several legacy behaviours must be skipped.
// XIF = Polaris Chord, VFG = Mahjong Fight Girl (MFG)
const EA3_UNITY = new Set(['XIF', 'VFG']);

// 8-digit zero-padded code derived from the refid (standard eamuse pcode).
// Must stay a string: numeric serialization would drop leading zeros.
function pcode(refid: string): string {
  try {
    const v = parseInt((refid || '').slice(0, 8), 16);
    if (!isNaN(v)) return String(v % 100000000).padStart(8, '0');
  } catch {}
  return '00000000';
}

// Derive a deterministic 16-digit numeric refid from an A+hex refid.
// Polaris Chord (XIF) rejects non-numeric refids (ThrowIfInvalidRefId),
// but we cannot change the card's stored refid in core.db because other
// games (SDVX, etc.) still use the original A+hex refid to find profiles.
// This mapping is lossless and deterministic: same A+hex → same numeric,
// so no side-table is needed — we re-derive it on every cardmng.inquire.
function deriveXifNumericRefid(hexRefid: string): string {
  let h = BigInt(5381);
  for (let i = 0; i < hexRefid.length; i++) {
    h = ((h << BigInt(5)) + h + BigInt(hexRefid.charCodeAt(i))) & BigInt('0xFFFFFFFFFFFFFFFF');
  }
  return (h % BigInt('10000000000000000')).toString().padStart(16, '0');
}

async function inquireAttrs(refid: string, gameCode: string) {
  // For EA3 Unity games (XIF = Polaris Chord), translate any A+hex refid to
  // a 16-digit numeric one before sending it to the client.  The client's
  // ThrowIfInvalidRefId would reject 'A93A7D4D29854E2B' with
  // "RefID contains invalid character" and abort the login flow.
  // We translate ONLY in the response — the stored refid in core.db stays
  // as-is so that SDVX and other legacy games remain unaffected.
  // We also ensure a phantom core.db profile exists under the numeric refid
  // so that plugin DB.Upsert (which guards with FindProfile) does not reject
  // polaris@asphyxia profile saves.
  let effectiveRefid = refid;
  if (EA3_UNITY.has(gameCode) && !/^[0-9]{16}$/.test(refid)) {
    effectiveRefid = deriveXifNumericRefid(refid);
    // Fire-and-forget — don't block the inquire response on the insert.
    EnsurePhantomProfile(effectiveRefid, gameCode).catch(() => {});
  }
  return {
    binded: (await CheckProfile(gameCode, effectiveRefid)) ? 1 : 0,
    dataid: effectiveRefid,
    ecflag: 1,
    expired: 0,
    newflag: 0,
    pcode: pcode(refid),
    refid: effectiveRefid,
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




  if (!card) {
    // Create new account
    return send.status(112);
  }

  const profile = await FindProfile(card.__refid);
  if (!profile) {
    await DeleteCard(cid);
    return send.status(112);
  }

  if (profile.pin === 'unset') {
    // EA3 Unity (XIF/JBC): same native-header limitation — let it through,
    // the PIN is (re)set via getrefid and authpass accepts anything over HTTP.
    if (!EA3_UNITY.has(info.gameCode)) {
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

  // EA3 Unity (XIF = Polaris Chord, VFG = MFG): the client sends the derived
  // numeric refid which doesn't exist in core.db (the stored refid is A+hex).
  // FindProfile would return null and we'd send status 110, crashing the
  // login flow. Skip the lookup entirely — these clients report auth failures
  // via the NATIVE header which the HTTP transport cannot carry per-method,
  // so the PIN check is irrelevant over HTTP. Accept unconditionally.
  if (EA3_UNITY.has(info.gameCode)) {
    return send.success();
  }

  const profile = await FindProfile(refid);

  if (!profile) {
    return send.status(110);
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
