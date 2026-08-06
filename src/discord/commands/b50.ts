import { AttachmentBuilder } from 'discord.js';
import { FindProfile, GET_DB } from '../../utils/EamuseIO';
import { renderB50 } from '../renderer';
import { getSdvxTitle, getSdvxDiff } from '../../webui/routes/profile';
import { sdvxJacketUrl } from '../../utils/sdvx_jacket_resolver';
import { getRefidForUsername, acquireRenderSlot, releaseRenderSlot } from './helpers';
import { getCachedRender, putCachedRender } from '../render_cache';

export async function handleBest50Command(interaction: any) {
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

  // Calculate Volforce and get top 50
  const vfRecords = records.filter((r: any) => r.volforce !== undefined);
  vfRecords.sort((a: any, b: any) => (b.volforce || 0) - (a.volforce || 0));
  const top50 = vfRecords.slice(0, 50);
  const totalVf = top50.reduce((acc: number, cur: any) => acc + (cur.volforce || 0), 0) / 1000;

  // Cache key changes whenever the player's data changes (any score updated).
  // While the player hasn't played, repeated /b50 replies come back instantly.
  const maxUpdatedAt = records.reduce(
    (m: number, r: any) => Math.max(m, r.updatedAt ? new Date(r.updatedAt).getTime() : 0),
    0
  );
  const cacheKey = `b50:${refid}:${profile.name}:${records.length}:${maxUpdatedAt}`;

  const cachedPng = getCachedRender(cacheKey);
  if (cachedPng) {
    const attachment = new AttachmentBuilder(cachedPng, { name: 'b50.png' });
    return interaction.editReply({ files: [attachment] });
  }

  const plays = top50.map((play: any) => ({
    title: getSdvxTitle(play.mid),
    diff: getSdvxDiff(play.mid, play.type),
    score: play.score || 0,
    volforce: play.volforce || 0,
    jacketUrl: sdvxJacketUrl(play.mid, play.type)
  }));

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
    const buffer = await renderB50(plays, profile, totalVf);
    putCachedRender(cacheKey, buffer);
    const attachment = new AttachmentBuilder(buffer, { name: 'b50.png' });
    await interaction.editReply({ files: [attachment] });
  } catch (err) {
    console.error('[Discord] Canvas render error:', err);
    await interaction.editReply('❌ Failed to generate B50 image.');
  } finally {
    releaseRenderSlot();
  }
}
