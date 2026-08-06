import { Client, GatewayIntentBits, REST, Routes, Interaction, SlashCommandBuilder } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/Logger';
import { CONFIG } from '../utils/ArgConfig';
import { prewarmJacketRoots } from '../utils/sdvx_jacket_resolver';
import { handleRecentScoreCommand } from './commands/rs';
import { handleBest50Command } from './commands/b50';

let client: Client | null = null;

// Per-user per-command cooldown so a crowd of users can't hammer the renderer.
const COOLDOWN_MS = 15000;
const COOLDOWN_MAX_ENTRIES = 2000;
const commandCooldowns = new Map<string, number>();

const commands = [
  new SlashCommandBuilder()
    .setName('rs')
    .setDescription('Show recent SDVX score for a user')
    .addStringOption(option =>
      option.setName('user')
        .setDescription('RyuNET username')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName('b50')
    .setDescription('Show top 50 SDVX scores (B50) for a user')
    .addStringOption(option =>
      option.setName('user')
        .setDescription('RyuNET username')
        .setRequired(true))
];

/**
 * Safely executes a command handler. Any unhandled error is caught, logged,
 * and a friendly error reply is sent to Discord. The game server is NEVER affected.
 */
async function safeExecute(name: string, interaction: any, handler: (i: any) => Promise<any>) {
  try {
    await handler(interaction);
  } catch (err) {
    Logger.error(`[Discord] Unhandled error in command /${name}: ${err}`);
    try {
      const msg = { content: '❌ An internal error occurred. Please try again later.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg).catch(() => {});
      } else {
        await interaction.reply(msg).catch(() => {});
      }
    } catch { /* ignore reply failures */ }
  }
}

export async function StartDiscordBot() {
  const token = CONFIG.discord_bot_token;
  const clientId = CONFIG.discord_client_id;

  if (!token || !clientId) {
    Logger.info('[Discord] Bot token or client ID not configured. Discord integration is disabled.');
    return;
  }

  Logger.info('[Discord] Starting bot...');

  client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  // ---- Automatic icudtl.dat extraction ----
  // Skia needs icudtl.dat in the working directory to render text.
  // If it's missing, we extract it from the pkg snapshot dynamically.
  try {
    const icuDest = path.join(process.cwd(), 'icudtl.dat');
    if (!fs.existsSync(icuDest)) {
      const icuSrc = path.join(__dirname, 'icudtl.dat');
      if (fs.existsSync(icuSrc)) {
        fs.copyFileSync(icuSrc, icuDest);
        Logger.info('[Discord] Automatically extracted icudtl.dat to working directory.');
      } else {
        Logger.warn('[Discord] icudtl.dat not found in bundle. Discord text rendering may crash the server!');
      }
    }
  } catch (err) {
    Logger.error(`[Discord] Failed to check/extract icudtl.dat: ${err}`);
  }

  // ---- Pre-warm jacket folder cache asynchronously (never blocks startup) ----
  // Loads the music-root directory listings once so jacket lookups don't
  // touch the disk synchronously during commands / web UI renders.
  try {
    void prewarmJacketRoots();
  } catch (err) {
    Logger.error(`[Discord] Jacket prewarm failed (non-fatal): ${err}`);
  }

  // ---- Error isolation: log and continue, never crash ----
  client.on('error', err => {
    Logger.error(`[Discord] Client error (server unaffected): ${err}`);
  });

  client.on('warn', msg => {
    Logger.warn?.(`[Discord] Warning: ${msg}`);
  });

  client.on('shardError', err => {
    Logger.error(`[Discord] Shard connection error (server unaffected): ${err}`);
  });

  client.once('ready', async (c) => {
    Logger.info(`[Discord] Bot logged in as ${c.user.tag}`);

    // Register slash commands globally
    try {
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      Logger.info('[Discord] Successfully registered slash commands.');
    } catch (error) {
      Logger.error(`[Discord] Failed to register slash commands (bot still running): ${error}`);
    }
  });

  client.on('interactionCreate', async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'rs' || interaction.commandName === 'b50') {
      // Per-user cooldown: reply immediately (ephemeral) instead of queuing work
      const now = Date.now();
      const cdKey = `${interaction.user.id}:${interaction.commandName}`;
      const last = commandCooldowns.get(cdKey) || 0;
      if (now - last < COOLDOWN_MS) {
        const remaining = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
        return interaction
          .reply({
            content: `⏳ Wait ${remaining}s before using /${interaction.commandName} again.`,
            ephemeral: true,
          })
          .catch(() => {});
      }
      commandCooldowns.set(cdKey, now);
      if (commandCooldowns.size > COOLDOWN_MAX_ENTRIES) {
        const oldest = commandCooldowns.keys().next().value;
        if (oldest !== undefined) commandCooldowns.delete(oldest);
      }

      if (interaction.commandName === 'rs') {
        await safeExecute('rs', interaction, handleRecentScoreCommand);
      } else {
        await safeExecute('b50', interaction, handleBest50Command);
      }
    }
  });

  // ---- Login with retry isolation ----
  try {
    await client.login(token);
  } catch (error) {
    Logger.error(`[Discord] Failed to login (server is unaffected): ${error}`);
    // Do NOT rethrow — caller (.catch in AsphyxiaCore) handles top-level failures
    // But here we already caught it, so the promise resolves cleanly.
  }
}
