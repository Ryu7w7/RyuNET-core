import { set, get } from 'lodash';

import { kitem } from '../../utils/KBinJSON';
import { EamuseRouteContainer } from '../EamuseRouteContainer';
import { FindCard, FindProfile } from '../../utils/EamuseIO';

export const eacoin = new EamuseRouteContainer();

eacoin.add('eacoin.checkout', async (info, data, send) => {
  send.success();
  return;
});

function extractString(val: any): string | null {
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null && typeof val['@content'] === 'string') return val['@content'];
  return null;
}

async function getPaseliBalanceAndSessid(data: any): Promise<{balance: number, sessid: string}> {
  let cid = extractString(get(data, '@attr.cardid')) || extractString(get(data, 'cardid')) || extractString(get(data, 'pass.[0].@attr.id'));
  let refid = extractString(get(data, '@attr.refid')) || extractString(get(data, 'refid'));
  let sessid = extractString(get(data, '@attr.sessid')) || extractString(get(data, 'sessid'));

  if (sessid && sessid !== 'DEADC0DEFEEDBEEF' && sessid.length > 5) {
    if (sessid.startsWith('CID:')) cid = sessid.slice(4);
    else if (sessid.startsWith('REF:')) refid = sessid.slice(4);
  }

  let finalSessid = 'DEADC0DEFEEDBEEF';
  if (cid) finalSessid = `CID:${cid}`;
  else if (refid) finalSessid = `REF:${refid}`;

  if (cid) {
    const card = await FindCard(cid);
    if (card && card.__refid) {
      const profile = await FindProfile(card.__refid) as any;
      if (profile && profile.paseli != null) return { balance: parseInt(profile.paseli, 10), sessid: finalSessid };
    }
  }

  if (refid) {
    const profile = await FindProfile(refid) as any;
    if (profile && profile.paseli != null) return { balance: parseInt(profile.paseli, 10), sessid: finalSessid };
  }

  return { balance: 10000, sessid: finalSessid };
}

eacoin.add('eacoin.checkin', async (info, data, send) => {
  const result = {};

  const { balance, sessid } = await getPaseliBalanceAndSessid(data);

  set(result, 'balance', kitem('s32', balance));
  set(result, 'sessid', kitem('str', sessid));
  set(result, 'acstatus', kitem('u8', 0));
  set(result, 'sequence', kitem('s16', 1));
  set(result, 'acid', kitem('str', 'EACOIN'));
  set(result, 'acname', kitem('str', 'EACOIN'));

  send.object(result);
  return;
});

eacoin.add('eacoin.consume', async (info, data, send) => {
  const result = {};

  const { balance } = await getPaseliBalanceAndSessid(data);

  set(result, 'autocharge', kitem('u8', 0));
  set(result, 'acstatus', kitem('u8', 0));
  set(result, 'balance', kitem('s32', balance));

  send.object(result);
  return;
});
