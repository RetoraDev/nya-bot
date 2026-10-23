require('dotenv').config();

const { Client, Events, GatewayIntentBits, REST, Routes, ChannelType } = require('discord.js');
const http = require('http');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, PORT } = process.env;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Nya is running');
});

server.listen(PORT || 3000, () => {
  console.log(`Keep-alive server listening on port ${PORT || 3000}`);
});

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'ping',
    description: 'Replies with Pong!',
  },
  {
    name: 'links',
    description: 'Get the PadManiacs links.',
  },
  {
    name: 'report',
    description: 'How to report a bug or request a feature.',
  },
  {
    name: 'tag',
    description: 'Assign a tag to this forum post (Founder only).',
    options: [
      {
        name: 'tag',
        description: 'Tag to assign',
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log('Registered /ping command.');
  } catch (error) {
    console.error(error);
  }
})();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'tag') return;

    const channel = interaction.channel;

    if (!channel?.isThread() || channel.parent?.type !== ChannelType.GuildForum) {
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused().toLowerCase();
    const choices = (channel.parent.availableTags || [])
      .filter((tag) => tag.moderated)
      .filter((tag) => tag.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((tag) => ({ name: tag.name, value: tag.name }));

    await interaction.respond(choices);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
    return;
  }

  if (interaction.commandName === 'links') {
    await interaction.reply({
      content: [
        'itch.io: https://retora.itch.io/padmaniacs',
        'GitHub: https://github.com/RetoraDev/PadManiacs',
        'Modding docs: https://retoradev.github.io/PadManiacs/docs/',
        'Testing build: https://retoradev.github.io/PadManiacs/dist/',
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'report') {
    await interaction.reply({
      content: [
        'Bugs: post in #bug-reports with version, platform, and steps to reproduce.',
        'Features: post in #feature-requests, one idea per post.',
        'Note: itch.io comments can be delayed by the spam filter, Discord is faster.',
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'tag') {
    const hasFounder = interaction.member?.roles?.cache?.some(
      (role) => role.name === 'Founder'
    );

    if (!hasFounder) {
      await interaction.reply({
        content: 'Only the Founder can use this command.',
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.channel;

    if (!channel?.isThread() || channel.parent?.type !== ChannelType.GuildForum) {
      await interaction.reply({
        content: 'This command can only be used in a forum post thread.',
        ephemeral: true,
      });
      return;
    }

    const tagName = interaction.options.getString('tag');
    const availableTags = channel.parent.availableTags || [];
    const tag = availableTags.find(
      (t) => t.moderated && t.name === tagName
    );

    if (!tag) {
      await interaction.reply({
        content: 'Selected tag not found on this forum.',
        ephemeral: true,
      });
      return;
    }

    try {
      const moderatedIds = new Set(
        availableTags.filter((t) => t.moderated).map((t) => t.id)
      );
      const keptTags = (channel.appliedTags || []).filter(
        (id) => !moderatedIds.has(id)
      );

      await channel.setAppliedTags([...keptTags, tag.id]);
      await interaction.reply({
        content: `Applied tag: ${tag.name}`,
        ephemeral: true,
      });
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: 'Failed to apply tag.',
        ephemeral: true,
      });
    }
    return;
  }
});

client.login(DISCORD_TOKEN);
