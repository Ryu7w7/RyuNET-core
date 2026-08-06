import { AttachmentBuilder } from 'discord.js';
import { FindProfile, GET_DB } from '../../utils/EamuseIO';
import { renderRecentScore } from '../renderer';
import { getSdvxTitle, getSdvxDiff } from '../../webui/routes/profile';
import { sdvxJacketUrl } from '../../utils/sdvx_jacket_resolver';
import { getRefidForUsername, acquireRenderSlot, releaseRenderSlot } from './helpers';
import { getCachedRender, putCachedRender } from '../render_cache';

function getGradeText(score: number): string {
  if (score >= 9900000) return 'S';
  if (score >= 9800000) return 'AAA+';
  if (score >= 9700000) return 'AAA';
  if (score >= 9500000) return 'AA+';
  if (score >= 9300000) return 'AA';
  if (score >= 9000000) return 'A+';
  if (score >= 8700000) return 'A';
  if (score >= 7500000) return 'B';
  if (score >= 6500000) return 'C';
  return 'D';
}

export async function handleRecentScoreCommand(interaction: any) {
  await interaction.deferReply();

  const username = interaction.options.getString('user');
  if (!username) {
    return interaction.editReply('❌ Username is required.');
  }

  // Resolve username -> refid via the card link (same as web UI)
  const refid = await getRefidForUsername(username);
  if (!refid) {
    return interaction.editReply(`❌ User **${username}** not found in RyuNET, or has no linked card.`);
  }

  // FindProfile returns a single object or null/false
  const profile = await FindProfile(refid);
  if (!profile) {
    return interaction.editReply(`❌ No RyuNET profile found for **${username}**.`);
  }

  // Only respond if the player has SDVX data
  const sdvxDB = await GET_DB('sdvx@asphyxia');
  if (!sdvxDB) {
    return interaction.editReply('❌ SDVX plugin database is not available on this server.');
  }

  let records: any[];
  try {
    records = await sdvxDB.findAsync({
      __s: 'plugins_profile',
      collection: 'music',
      __refid: refid
    });
  } catch (err) {
    console.error('[Discord] DB query error:', err);
    return interaction.editReply('❌ Failed to query SDVX data.');
  }

  if (!records || records.length === 0) {
    return interaction.editReply(`📭 **${username}** hasn't played SDVX yet (no scores found).`);
  }

  // Sort by updatedAt descending to get the most recent score
  records.sort((a: any, b: any) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });

  const recent = records[0];

  // Cache key changes whenever the player's data changes (any score updated).
  // While the player hasn't played, repeated /rs replies come back instantly.
  const maxUpdatedAt = records.reduce(
    (m: number, r: any) => Math.max(m, r.updatedAt ? new Date(r.updatedAt).getTime() : 0),
    0
  );
  const cacheKey = `rs:${refid}:${profile.name}:${records.length}:${maxUpdatedAt}`;

  const cachedPng = getCachedRender(cacheKey);
  if (cachedPng) {
    const attachment = new AttachmentBuilder(cachedPng, { name: 'recent_score.png' });
    return interaction.editReply({ files: [attachment] });
  }

  const playData = {
    title: getSdvxTitle(recent.mid),
    diff: getSdvxDiff(recent.mid, recent.type),
    score: recent.score || 0,
    exscore: recent.exscore || 0,
    gradeText: getGradeText(recent.score || 0),
    volforce: recent.volforce || 0,
    jacketUrl: sdvxJacketUrl(recent.mid, recent.type),
    maxChain: recent.maxChain || 0,
    critical: recent.critical || 0,
    s_critical: recent.s_critical || recent.just || 0,
    near: recent.near || 0,
    error: recent.error || 0
  };

  // ---- Final safety check against Skia C++ crash ----
  const fs = require('fs');
  const path = require('path');
  if (!fs.existsSync(path.join(process.cwd(), 'icudtl.dat'))) {
    return interaction.editReply('❌ **Server Error:** `icudtl.dat` is missing from the server directory. Text rendering is disabled to prevent crashes.');
  }

  // Limit concurrent renders so a command burst can't slow down the game server
  const hasSlot = await acquireRenderSlot();
  if (!hasSlot) {
    return interaction.editReply('⚠️ The bot is busy generating images right now, try again in a moment.');
  }

  try {
    const buffer = await renderRecentScore(playData, profile);
    putCachedRender(cacheKey, buffer);
    const attachment = new AttachmentBuilder(buffer, { name: 'recent_score.png' });
    await interaction.editReply({ files: [attachment] });
  } catch (err) {
    console.error('[Discord] Canvas render error:', err);
    await interaction.editReply('❌ Failed to generate score image.');
  } finally {
    releaseRenderSlot();
  }
}
