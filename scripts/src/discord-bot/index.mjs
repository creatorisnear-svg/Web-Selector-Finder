import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  MessageFlags
} from 'discord.js';
import { searchVideos, getDirectMp4 } from './scraper.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID environment variables.');
  process.exit(1);
}

// Per-guild website settings: guildId -> searchUrlTemplate
const guildSettings = new Map();

// Temporary search results store: key -> results array
// key = `${userId}-${timestamp}`
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

client.on('interactionCreate', async interaction => {

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

      // Store results so we can look up the full URL by index later
      const key = `${interaction.user.id}-${Date.now()}`;
      pendingResults.set(key, top10);
      // Auto-clean after 5 minutes
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

    // Acknowledge the pick immediately so Discord doesn't time out
    await interaction.update({
      content: `⏳ Finding the video file for **${picked.title}**...`,
      components: []
    });

    // Try to extract a direct .mp4 URL from the video page
    const mp4Url = await getDirectMp4(picked.url);

    if (mp4Url) {
      await interaction.editReply({
        content: `🎬 **${picked.title}**\n${mp4Url}`
      });
    } else {
      // Fall back to the page link if no mp4 found
      await interaction.editReply({
        content: `🎬 **${picked.title}**\n${picked.url}\n\n> ⚠️ Could not find a direct video file — this site may load videos with JavaScript. The link above will open the page.`
      });
    }
  }
});

await registerCommands();
client.login(TOKEN);
