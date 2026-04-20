import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags
} from 'discord.js';
import { searchVideos, getVideoStreamUrl, downloadVideoClip, cleanupClip } from './scraper.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID environment variables.');
  process.exit(1);
}

// Per-guild website settings: guildId -> searchUrlTemplate
const guildSettings = new Map();

// Temporary search results store: key -> results array
const pendingResults = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('website')
    .setDescription('Set the website to search for videos')
    .addStringOption(opt =>
      opt
        .setName('url')
        .setDescription('Search URL with {query} placeholder — e.g. https://example.com/search?q={query}')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search for videos on the configured website')
    .addStringOption(opt =>
      opt
        .setName('query')
        .setDescription('What to search for')
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  console.log(`Bot is online as ${client.user.tag}`);
});

// Wrap the whole handler so one bad interaction never crashes the bot
client.on('interactionCreate', async interaction => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    console.error('Interaction error:', err.message);
    // Attempt to tell the user something went wrong (best-effort)
    try {
      const msg = { content: '❌ Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch (_) {}
  }
});

async function handleInteraction(interaction) {
  // ── Slash commands ──────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    const { commandName, guildId } = interaction;

    // /website
    if (commandName === 'website') {
      const url = interaction.options.getString('url');

      if (!url.includes('{query}')) {
        await interaction.reply({
          content: '❌ Your URL must contain `{query}` so the bot knows where to put the search term.\nExample: `https://example.com/search?q={query}`',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      guildSettings.set(guildId, url);
      await interaction.reply({
        content: `✅ Website saved! Searches will use:\n\`${url}\``,
        flags: MessageFlags.Ephemeral
      });
    }

    // /search
    if (commandName === 'search') {
      const searchUrlTemplate = guildSettings.get(guildId);

      if (!searchUrlTemplate) {
        await interaction.reply({
          content: '❌ No website set yet. Use `/website` first.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const query = interaction.options.getString('query');
      await interaction.deferReply();

      let results;
      try {
        results = await searchVideos(searchUrlTemplate, query);
      } catch (err) {
        console.error('Scrape error:', err.message);
        await interaction.editReply(`❌ Could not fetch results: ${err.message}`);
        return;
      }

      if (!results || results.length === 0) {
        await interaction.editReply(
          `❌ No results found for **${query}**.\nTry a different search term, or check your website URL with \`/website\`.`
        );
        return;
      }

      const top10 = results.slice(0, 10);

      const key = `${interaction.user.id}-${Date.now()}`;
      pendingResults.set(key, top10);
      setTimeout(() => pendingResults.delete(key), 5 * 60 * 1000);

      const select = new StringSelectMenuBuilder()
        .setCustomId(`pick_video:${interaction.user.id}:${key}`)
        .setPlaceholder('Choose a video...')
        .addOptions(
          top10.map((r, i) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${i + 1}. ${r.title.slice(0, 97)}`)
              .setValue(String(i))
          )
        );

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `🔎 **${top10.length} results** for "${query}" — pick one:`,
        components: [row]
      });
    }
  }

  // ── Select menu ─────────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const parts = interaction.customId.split(':');
    if (parts[0] !== 'pick_video') return;

    const [, userId, key] = parts;

    if (interaction.user.id !== userId) {
      await interaction.reply({
        content: '❌ Only the person who ran `/search` can pick from this menu.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const results = pendingResults.get(key);
    if (!results) {
      await interaction.update({
        content: '❌ This search has expired. Run `/search` again.',
        components: []
      });
      return;
    }

    const index = parseInt(interaction.values[0], 10);
    const picked = results[index];
    pendingResults.delete(key);

    await interaction.update({
      content: `⏳ Downloading **${picked.title}**... (this may take a few seconds)`,
      components: []
    });

    // Step 1: Find the video stream URL on the page (for our custom downloader)
    const stream = await getVideoStreamUrl(picked.url);

    // Step 2: Download — try axios (fast, for simple sites) then yt-dlp (handles auth, many sites)
    const filePath = await downloadVideoClip(
      stream?.url || '',
      stream?.cookies || '',
      picked.url
    );

    if (filePath) {
      // Upload the file as a Discord attachment — plays inline
      const attachment = new AttachmentBuilder(filePath, { name: 'video.mp4' });
      await interaction.editReply({
        content: `🎬 **${picked.title}**`,
        files: [attachment]
      });
      await cleanupClip(filePath);
    } else {
      // Download failed (CDN block, too large, or unsupported site) — send page link
      await interaction.editReply({
        content: `🎬 **${picked.title}**\n${picked.url}\n\n> ⚠️ Couldn't download this video directly (the site may block server-side access). Click the link above to watch.`
      });
    }
  }
}

await registerCommands();
client.login(TOKEN);
