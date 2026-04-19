import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
  InteractionType,
  ComponentType
} from 'discord.js';
import { searchVideos } from './scraper.mjs';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID environment variables.');
  process.exit(1);
}

// Store per-guild website settings: guildId -> searchUrlTemplate
const guildSettings = new Map();

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('website')
    .setDescription('Set the website to search for videos')
    .addStringOption(opt =>
      opt
        .setName('url')
        .setDescription('Search URL with {query} placeholder, e.g. https://example.com/search?q={query}')
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

// Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`Bot is online as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    const { commandName, guildId } = interaction;

    if (commandName === 'website') {
      const url = interaction.options.getString('url');

      if (!url.includes('{query}')) {
        await interaction.reply({
          content: '❌ Your URL must include `{query}` as a placeholder. Example:\n`https://example.com/search?q={query}`',
          ephemeral: true
        });
        return;
      }

      guildSettings.set(guildId, url);
      await interaction.reply({
        content: `✅ Website set! Searches will use:\n\`${url}\``,
        ephemeral: true
      });
    }

    if (commandName === 'search') {
      const searchUrlTemplate = guildSettings.get(guildId);

      if (!searchUrlTemplate) {
        await interaction.reply({
          content: '❌ No website set yet. Use `/website` first to set a search URL.',
          ephemeral: true
        });
        return;
      }

      const query = interaction.options.getString('query');
      await interaction.deferReply();

      let results;
      try {
        results = await searchVideos(searchUrlTemplate, query);
      } catch (err) {
        await interaction.editReply(`❌ Failed to fetch results: ${err.message}`);
        return;
      }

      if (!results || results.length === 0) {
        await interaction.editReply(`❌ No results found for **${query}**. Try a different search or website.`);
        return;
      }

      const top10 = results.slice(0, 10);

      const select = new StringSelectMenuBuilder()
        .setCustomId(`pick_video:${interaction.user.id}`)
        .setPlaceholder('Pick a video...')
        .addOptions(
          top10.map((r, i) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${i + 1}. ${r.title.slice(0, 100)}`)
              .setValue(r.url.slice(0, 100))
          )
        );

      const row = new ActionRowBuilder().addComponents(select);

      await interaction.editReply({
        content: `🔎 Found **${top10.length}** results for **${query}** — pick one:`,
        components: [row]
      });
    }
  }

  // Select menu interaction
  if (interaction.isStringSelectMenu()) {
    const [prefix, userId] = interaction.customId.split(':');
    if (prefix !== 'pick_video') return;

    if (interaction.user.id !== userId) {
      await interaction.reply({ content: '❌ Only the person who searched can pick a video.', ephemeral: true });
      return;
    }

    const videoUrl = interaction.values[0];
    await interaction.update({ content: `🎬 Here's your video:\n${videoUrl}`, components: [] });
  }
});

await registerCommands();
client.login(TOKEN);
