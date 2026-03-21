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
} from '../../utils/EamuseIO';

export const cardmng = new EamuseRouteContainer();

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

  const card = await FindCard(cid);

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
    // need update pin
    return send.status(112);
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
      binded: (await CheckProfile(info.gameCode, card.__refid)) ? 1 : 0,
      dataid: card.__refid,
      ecflag: 1,
      expired: 0,
      newflag: 0,
      refid: card.__refid,
    },
  });

  return;
});

cardmng.add('cardmng.getrefid', async (info, data, send) => {
  const cid: string = get(data, '@attr.cardid');
  const pin: string = get(data, '@attr.passwd');

  const card = await FindCard(cid);
  if (card) {
    // Card exists, update profile pin
    const updated = await UpdateProfile(card.__refid, { pin }, true);
    if (updated) {
      await BindProfile(card.__refid, info.gameCode);
      return send.object({ '@attr': { dataid: card.__refid, refid: card.__refid } });
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

  send.object({ '@attr': { dataid: refid, refid } });
  return;
});

cardmng.add('cardmng.authpass', async (info, data, send) => {
  const refid = get(data, '@attr.refid', null);
  const pass = get(data, '@attr.pass', '-1');

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
