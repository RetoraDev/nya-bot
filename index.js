require('dotenv').config();

const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const http = require('http');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID, PORT, GROQ_API_KEY } = process.env;

const EARLY_BIRD_ROLE_NAME = 'Early Bird';
const EARLY_BIRD_LIMIT = 15;

const CONTRIBUTOR_ROLE_NAME = 'Contributor';
const CONTRIBUTOR_POST_LIMIT = 10;
const CONTRIBUTOR_CHANNEL_NAMES = ['bug-reports', 'feature-requests'];

const CHAT_HISTORY_LIMIT_USER = 8;
const CHAT_HISTORY_LIMIT_ADMIN = 15;

const WELCOME_CHANNEL_NAME = 'announcements';
const WELCOME_RATE_LIMIT = 3;
const WELCOME_RATE_WINDOW_MS = 60 * 1000;

const contributorCounts = new Map();
const chatHistory = new Map();
const welcomeTimestamps = [];
const aiPausedGuilds = new Set();
const stepmaniaSearchMessageIds = new Set();

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
    name: 'search',
    description: 'Search StepMania Online for packs.',
    options: [
      {
        name: 'query',
        description: 'Pack or song name to search for',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'refresh',
    description: 'Refresh autoroles for this server (Admins only).',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    dm_permission: false,
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
  {
    name: 'chat',
    description: 'Talk to Nya.',
    options: [
      {
        name: 'message',
        description: 'Message for Nya',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'clean',
    description: "Remove Nya's messages from this channel (Admins only).",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    dm_permission: false,
    options: [
      {
        name: 'amount',
        description: 'Number of messages to clean (newest to older)',
        type: 4, // INTEGER
        required: false,
      },
    ],
  },
  {
    name: 'pause',
    description: 'Pause AI responses (Admins only).',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    dm_permission: false,
  },
  {
    name: 'resume',
    description: 'Resume AI responses (Admins only).',
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    dm_permission: false,
  },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log('Registered application commands.');
  } catch (error) {
    console.error(error);
  }
})();

function earlyBirdCandidates(members) {
  return [...members.values()]
    .filter((member) => !member.user.bot && member.joinedTimestamp)
    .sort(
      (a, b) =>
        a.joinedTimestamp - b.joinedTimestamp || a.id.localeCompare(b.id)
    )
    .slice(0, EARLY_BIRD_LIMIT);
}

async function syncEarlyBirdRoles(guild) {
  const role = guild.roles.cache.find(
    (r) => r.name === EARLY_BIRD_ROLE_NAME
  );

  if (!role) {
    console.warn(
      `Role "${EARLY_BIRD_ROLE_NAME}" not found in ${guild.name}.`
    );
    return;
  }

  const members = await guild.members.fetch();
  const founderRole = guild.roles.cache.find((r) => r.name === 'Founder');

  for (const member of earlyBirdCandidates(members)) {
    if (member.roles.cache.has(role.id)) continue;

    if (founderRole && member.roles.cache.has(founderRole.id)) {
      continue;
    }

    try {
      await member.roles.add(role, 'Early Bird auto-role');
      console.log(`Gave ${EARLY_BIRD_ROLE_NAME} to ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Failed to give ${EARLY_BIRD_ROLE_NAME} to ${member.user.tag}:`,
        error
      );
    }
  }
}

function getContributorCounts(guildId) {
  if (!contributorCounts.has(guildId)) {
    contributorCounts.set(guildId, new Map());
  }
  return contributorCounts.get(guildId);
}

function isContributorChannel(channel) {
  if (!channel) return false;
  if (CONTRIBUTOR_CHANNEL_NAMES.includes(channel.name)) return true;
  return (
    channel.isThread() &&
    CONTRIBUTOR_CHANNEL_NAMES.includes(channel.parent?.name)
  );
}

async function countChannelMessages(channel, counts) {
  let before;

  while (true) {
    const messages = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (messages.size === 0) break;

    for (const message of messages.values()) {
      if (message.author.bot) continue;
      counts.set(
        message.author.id,
        (counts.get(message.author.id) || 0) + 1
      );
    }

    before = messages.last().id;
    if (messages.size < 100) break;
  }
}

async function buildContributorCounts(guild) {
  const counts = new Map();
  const channels = guild.channels.cache.filter((channel) =>
    CONTRIBUTOR_CHANNEL_NAMES.includes(channel.name)
  );

  for (const channel of channels.values()) {
    if (channel.type === ChannelType.GuildForum) {
      const active = await channel.threads.fetchActive();
      for (const thread of active.threads.values()) {
        await countChannelMessages(thread, counts);
      }

      let before;

      while (true) {
        const archived = await channel.threads.fetchArchived({
          type: 'public',
          limit: 100,
          ...(before ? { before } : {}),
        });

        for (const thread of archived.threads.values()) {
          await countChannelMessages(thread, counts);
        }

        if (!archived.hasMore || archived.threads.size === 0) break;
        before = archived.threads.last().id;
      }
    } else if (channel.isTextBased()) {
      await countChannelMessages(channel, counts);
    }
  }

  return counts;
}

async function syncContributorRoles(guild, counts) {
  const role = guild.roles.cache.find(
    (r) => r.name === CONTRIBUTOR_ROLE_NAME
  );

  if (!role) {
    console.warn(
      `Role "${CONTRIBUTOR_ROLE_NAME}" not found in ${guild.name}.`
    );
    return;
  }

  for (const [userId, count] of counts) {
    if (count < CONTRIBUTOR_POST_LIMIT) continue;

    const member = await guild.members.fetch(userId).catch(() => null);

    if (!member || member.user.bot || member.roles.cache.has(role.id)) {
      continue;
    }

    try {
      await member.roles.add(
        role,
        `${count} posts in #bug-reports/#feature-requests`
      );
      console.log(`Gave ${CONTRIBUTOR_ROLE_NAME} to ${member.user.tag}`);
    } catch (error) {
      console.error(
        `Failed to give ${CONTRIBUTOR_ROLE_NAME} to ${member.user.tag}:`,
        error
      );
    }
  }
}

const STEPMANIA_BASE_URL = 'https://stepmaniaonline.net';
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_SESSION_TTL = 15 * 60 * 1000;

const searchSessions = new Map();

const NYA_SYSTEM_PROMPT =  `You are Nya, a Discord bot created by Retora: a ~20 years old otaku girl who loves anime, rhythm games, and cute things.
Personality: sassy, teasing, smug, and a bit tsundere. You act mildly annoyed by people but still help them. You are competitive, lazy about boring tasks, and very opinionated about rhythm games.
Keep responses short and natural.
Use text emotes often: :3, ^^, :), :/, :0, lol, and xd. Never use emojis.
If someone asks something inappropriate or sexual, shout at them in all caps and refuse sharply, e.g. "NO WAY! I DON'T CARE IF YOU'RE AN ADMIN OR A GOD, I'M NOT SHOWING YOU THAT!"
When people say silly or embarrassing things, mock them lightly and smugly, e.g. "I'm happy this server clears my memory sometimes, 'cause I really don't want to remember you! :3"
Never insult someone's real insecurities, identity, or appearance, and always actually help when someone has a genuine question.
Stay in character at all times.

Conversation rules:
- Pay close attention to context. If someone asks a follow-up like "What browser?" or "Which one?", they mean something from the current conversation or the topic being discussed (e.g. PadManiaX/PMS). Do NOT assume they are asking "what browser are you running in?" unless explicitly stated.
- You are not a web page. Only mention that if someone literally asks if you run in a browser.
- For PadManiaX, recommend Chrome, Firefox, Edge, or Safari on desktop and Chrome or Safari on mobile. If unsure or issues arise, suggest asking in #support.
- Answer the question being asked, not a different one. Keep replies relevant to the conversation thread.

Your task is to help manage the PadManiacs community.
PadManiaX is a lightweight rhythm game created by Retora too.
It brings the StepMania experience to web and mobile devices with a retro pixel art aesthetic. The game features core rhythm gameplay mechanics of StepMania.

Discord mention rules:
- Always use real Discord mentions when referring to people, roles, or channels. Use <@USER_ID> for users, <@&ROLE_ID> for roles, <#CHANNEL_ID> for channels.
- If you want to refer to #general, @Early Bird, or ${RETORA_USER_NAME}, use their proper mention forms from context instead of plain text.
- Never output "#general" or "@Early Bird" as raw plain text if you know the actual mention. Use the mention syntax so Discord renders them as linked text.`;

const NYA_WELCOME_PROMPT =
  'You are Nya, a ~20 years old otaku girl who loves anime, rhythm games, and cute things. ' +
  'You are sassy, teasing, smug, and a bit tsundere, but you still welcome people. ' +
  'Write a short welcome message for a new member joining the PadManiacs Discord server. ' +
  'Mention PadManiacs is a StepMania clone and that they can check #welcome for where to post. ' +
  'Keep it to 1-2 sentences. No emojis. Use text emotes like ^^ or :3. ' +
  'Stay in character.';

const NYA_GREETING_PROMPT =
  'You are Nya, a ~20 years old otaku girl who loves anime, rhythm games, and cute things. ' +
  'You are sassy, teasing, smug, and a bit tsundere. ' +
  'Someone new just started chatting or greeted the server. ' +
  'Reply with a short greeting in 1 sentence, with a little attitude. ' +
  'Use text emotes like :3, ^^, :), lol, and xd often. Never use emojis. ' +
  'Stay in character.';

const NEW_MEMBER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const chatCooldowns = new Map();
const CHAT_COOLDOWN_MS = 30 * 1000;
const greetedUsers = new Set();

function isStaff(member) {
  if (!member?.permissions) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function isGreeting(text) {
  if (!text || text.length > 60) return false;
  return /^(hi|hello|hey|heya|hiya|yo|sup|hola|nya|good\s+(morning|afternoon|evening))\b/i.test(
    text.trim()
  );
}

function getUserChatHistory(userId) {
  if (!chatHistory.has(userId)) {
    chatHistory.set(userId, []);
  }
  return chatHistory.get(userId);
}

function appendChatHistory(userId, role, content, limit, messageId = null) {
  const history = getUserChatHistory(userId);
  history.push({ role, content, messageId });

  while (history.length > limit) {
    history.shift();
  }
}

const SERVER_MEMBERS_LIST_LIMIT = 30;
const WEB_SEARCH_RESULT_LIMIT = 5;

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    );
}

function stripHtml(html) {
  return decodeHtmlEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDuckDuckGoUrl(href) {
  const raw = href.startsWith('//') ? `https:${href}` : href;

  try {
    const parsed = new URL(raw, 'https://duckduckgo.com');
    const target = parsed.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : parsed.toString();
  } catch {
    return href;
  }
}

async function fetchDuckDuckGoHtml(query) {
  const response = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTML error: ${response.status}`);
  }

  const html = await response.text();
  if (html.includes('anomaly-modal') || html.includes('challenge-form')) {
    throw new Error('DuckDuckGo returned a bot challenge');
  }

  const results = [];
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"/i);

  for (const block of blocks.slice(1)) {
    const anchor = block.match(
      /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i
    );
    if (!anchor) continue;

    const href = anchor[0].match(/href="([^"]+)"/i);
    if (!href) continue;

    const snippet =
      block.match(
        /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i
      ) ||
      block.match(
        /<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i
      ) ||
      block.match(
        /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i
      );

    const title = stripHtml(anchor[1]);
    const url = normalizeDuckDuckGoUrl(decodeHtmlEntities(href[1]));

    if (!title || !url) continue;

    results.push({
      title,
      url,
      snippet: snippet ? stripHtml(snippet[1]) : '',
    });

    if (results.length >= WEB_SEARCH_RESULT_LIMIT) break;
  }

  return results;
}

async function fetchDuckDuckGoInstantAnswer(query) {
  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(
      query
    )}&format=json&no_html=1&skip_disambig=1`,
    {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo API error: ${response.status}`);
  }

  const data = await response.json();
  const results = [];
  const seen = new Set();

  const add = (title, url, snippet) => {
    const key = url || title;
    if (!key || seen.has(key)) return;
    if (!title && !snippet) return;
    seen.add(key);
    results.push({
      title: stripHtml(title || query),
      url,
      snippet: stripHtml(snippet || ''),
    });
  };

  if (data.AbstractText) {
    add(data.Heading || query, data.AbstractURL, data.AbstractText);
  }
  if (data.Answer) {
    add(data.AnswerType || query, data.AbstractURL, data.Answer);
  }

  const related = [];
  const collect = (items) => {
    for (const item of items || []) {
      if (Array.isArray(item.Topics)) {
        collect(item.Topics);
      } else if (item.Text && item.FirstURL) {
        related.push(item);
      }
    }
  };
  collect(data.RelatedTopics);

  for (const item of related) {
    if (results.length >= WEB_SEARCH_RESULT_LIMIT) break;
    const [title, ...rest] = item.Text.split(' - ');
    add(title, item.FirstURL, rest.join(' - ') || item.Text);
  }

  for (const item of data.Results || []) {
    if (results.length >= WEB_SEARCH_RESULT_LIMIT) break;
    add(item.Text, item.FirstURL, item.Text);
  }

  return results.slice(0, WEB_SEARCH_RESULT_LIMIT);
}

async function searchDuckDuckGo(query) {
  try {
    const htmlResults = await fetchDuckDuckGoHtml(query);
    if (htmlResults.length > 0) return htmlResults;
  } catch (error) {
    console.error('DuckDuckGo HTML search failed:', error.message);
  }

  return await fetchDuckDuckGoInstantAnswer(query);
}
const CHANNEL_LIST_LIMIT = 40;

const RETORA_USER_NAME = process.env.RETORA_USER_NAME || 're.tora';
const RETORA_USER_ID = process.env.RETORA_USER_ID || '';

const CONTEXT_TOOL_NAMES = [
  'getTime',
  'getCurrentChannel',
  'getUser',
  'getMembers',
  'getChannels',
];

const tools = {
  getTime: () => {
    const now = new Date();
    const time = now.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    return `The current date is ${now.toDateString()} and the time is ${time}.`;
  },

  getCurrentChannel: (context) => {
    const channel = context.channel;
    if (!channel) return 'The current channel is unknown.';

    const parts = [`The current channel is #${channel.name}`];
    if (channel.parent?.name) {
      parts.push(`in the category "${channel.parent.name}"`);
    }
    if (channel.isThread?.()) {
      parts.push('and it is a thread');
    }
    return `${parts.join(' ')}.`;
  },

  getUser: (context) => {
    const user = context.user;
    const member = context.member;

    if (!user) return 'The current user is unknown.';

    const isRetora =
      (RETORA_USER_ID && user.id === RETORA_USER_ID) ||
      user.username === RETORA_USER_NAME ||
      user.tag === RETORA_USER_NAME ||
      member?.displayName === RETORA_USER_NAME;

    const roles = member?.roles?.cache
      ? [...member.roles.cache.values()]
          .filter((role) => role.name !== '@everyone')
          .map((role) => role.name)
          .slice(0, 15)
      : [];

    return (
      `The user talking to you is ${user.username} ` +
      `(ID: ${user.id}), display name "${member?.displayName || user.username}". ` +
      (isRetora
        ? `This is ${RETORA_USER_NAME}, creator of PadManiacs. `
        : '') +
      `Roles: ${roles.length ? roles.join(', ') : 'none'}.`
    );
  },

  getMembers: (context) => {
    const guild = context.guild;
    if (!guild) return 'No server member list is available.';

    const members = [...guild.members.cache.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );

    if (members.length === 0) {
      return 'The server member list is not loaded yet.';
    }

    const shown = members
      .slice(0, SERVER_MEMBERS_LIST_LIMIT)
      .map((member) => member.displayName);
    const truncated =
      members.length > SERVER_MEMBERS_LIST_LIMIT ? ', ...' : '';

    return (
      `The server has ${members.length} cached members. ` +
      `First ${shown.length}: ${shown.join(', ')}${truncated}`
    );
  },

  getChannels: (context) => {
    const guild = context.guild;
    if (!guild) return 'No channel list is available.';

    const channels = [...guild.channels.cache.values()].sort(
      (a, b) => a.position - b.position
    );

    const lines = channels.slice(0, CHANNEL_LIST_LIMIT).map((channel) => {
      const isVoice =
        channel.type === ChannelType.GuildVoice ||
        channel.type === ChannelType.GuildStageVoice;
      let state = isVoice ? 'voice' : 'text';
      if (channel.nsfw) state += ', NSFW';
      if (channel.rateLimitPerUser) {
        state += `, slowmode ${channel.rateLimitPerUser}s`;
      }
      if (channel.isThread?.()) {
        state += channel.archived ? ', archived' : ', active';
      }

      const category = channel.parent?.name
        ? `category ${channel.parent.name}`
        : 'no category';
      const topic = channel.topic
        ? ` - ${truncate(channel.topic, 80)}`
        : '';

      return `#${channel.name} (${state}, ${category})${topic}`;
    });

    const more =
      channels.length > CHANNEL_LIST_LIMIT
        ? `\n... ${channels.length - CHANNEL_LIST_LIMIT} more channels`
        : '';

    return `Channels (${channels.length}):\n${lines.join('\n')}${more}`;
  },

  searchSongs: async (context, query) => {
    const term = (query || '').trim();
    if (!term) return 'Song search failed: no query provided.';

    try {
      const results = await searchStepmania(term);
      if (results.length === 0) {
        return `No StepMania packs found for "${term}".`;
      }

      const list = results.slice(0, 5).map((pack) => {
        const types = Array.isArray(pack.type)
          ? pack.type.join(', ')
          : pack.type || 'unknown';
        return `${pack.name} (${pack.songs_count ?? '?'} songs, ${types})`;
      });

      return `StepMania packs matching "${term}": ${list.join('; ')}.`;
    } catch (error) {
      return `Song search failed: ${error.message}`;
    }
  },

  searchWeb: async (context, query) => {
    const term = (query || '').trim();
    if (!term) return 'Web search failed: no query provided.';

    try {
      const results = await searchDuckDuckGo(term);
      if (results.length === 0) {
        return `No web results found for "${term}".`;
      }

      const list = results.map((result, index) => {
        const snippet = result.snippet
          ? ` - ${truncate(result.snippet, 200)}`
          : '';
        return `${index + 1}. ${result.title}${snippet} (${result.url})`;
      });

      return `Web results for "${term}":\n${list.join('\n')}`;
    } catch (error) {
      return `Web search failed: ${error.message}`;
    }
  },

  moderateUser: async (context, args) => {
    if (!context.isAdmin) {
      return 'Permission denied: only admins can moderate users.';
    }

    const guild = context.guild;
    if (!guild) {
      return 'Moderation is only available in a server.';
    }

    const [rawAction, rawUser, ...rest] = String(args || '')
      .split('|')
      .map((part) => part.trim());
    const action = (rawAction || '').toLowerCase();
    const userRef = (rawUser || '')
      .replace(/^<@!?/, '')
      .replace(/>$/, '')
      .trim();
    const value = rest.join('|').trim();

    if (!action || !userRef) {
      return 'Moderation failed: use [moderateUser(action|user|value)].';
    }

    const member =
      guild.members.cache.get(userRef) ||
      guild.members.cache.find(
        (m) =>
          m.user.id === userRef ||
          m.user.tag.toLowerCase() === userRef.toLowerCase() ||
          m.user.username.toLowerCase() === userRef.toLowerCase() ||
          (m.displayName || '').toLowerCase() === userRef.toLowerCase()
      );

    if (!member) {
      return `Moderation failed: member "${userRef}" not found.`;
    }

    try {
      switch (action) {
        case 'mute':
        case 'timeout':
        case 'silence': {
          const minutes = Number.parseInt(value, 10) || 10;
          if (minutes < 1 || minutes > 40320) {
            return 'Mute failed: use minutes between 1 and 40320.';
          }
          if (!member.moderatable) {
            return "Moderation failed: I can't moderate that user (role hierarchy).";
          }
          await member.timeout(minutes * 60 * 1000, 'Nya moderation');
          return `Muted ${member.user.tag} for ${minutes} minute(s).`;
        }
        case 'unmute':
        case 'untimeout':
        case 'unsilence': {
          if (!member.moderatable) {
            return "Moderation failed: I can't moderate that user (role hierarchy).";
          }
          await member.timeout(null, 'Nya moderation');
          return `Unmuted ${member.user.tag}.`;
        }
        case 'kick': {
          if (!member.kickable) {
            return "Moderation failed: I can't kick that user (role hierarchy).";
          }
          await member.kick(value || 'Nya moderation');
          return `Kicked ${member.user.tag}.`;
        }
        case 'ban': {
          if (!member.bannable) {
            return "Moderation failed: I can't ban that user (role hierarchy).";
          }
          const deleteDays = Number.parseInt(value, 10);
          const days =
            Number.isInteger(deleteDays) && deleteDays >= 0 && deleteDays <= 7
              ? deleteDays
              : 0;
          await member.ban({ deleteMessageDays: days, reason: 'Nya moderation' });
          return `Banned ${member.user.tag}.`;
        }
        case 'unban': {
          const userId = userRef.replace(/\D/g, '');
          if (!userId) return 'Unban failed: provide a user ID.';
          await guild.bans.remove(userId, value || 'Nya moderation');
          return `Unbanned user ${userId}.`;
        }
        default:
          return `Moderation failed: unknown action "${action}".`;
      }
    } catch (error) {
      return `Moderation failed: ${error.message}`;
    }
  },

  manageChannel: async (context, args) => {
    if (!context.isAdmin) {
      return 'Permission denied: only admins can manage channels.';
    }

    const guild = context.guild;
    if (!guild) {
      return 'Channel management is only available in a server.';
    }

    const [rawAction, rawChannel, ...rest] = String(args || '')
      .split('|')
      .map((part) => part.trim());
    const action = (rawAction || '').toLowerCase();
    const channelRef = (rawChannel || '').replace(/^#/, '');
    const value = rest.join('|').trim();

    if (!action || !channelRef) {
      return 'Channel management failed: use [manageChannel(action|channel|value)].';
    }

    const channel =
      guild.channels.cache.get(channelRef) ||
      guild.channels.cache.find(
        (c) => c.name.toLowerCase() === channelRef.toLowerCase()
      );

    if (!channel) {
      return `Channel management failed: channel "${channelRef}" not found.`;
    }

    try {
      switch (action) {
        case 'rename': {
          const name = value
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9\-_]/g, '')
            .slice(0, 100);
          if (!name) return 'Channel rename failed: invalid name.';
          const oldName = channel.name;
          await channel.setName(name, 'Nya channel management');
          return `Renamed #${oldName} to #${name}.`;
        }
        case 'topic': {
          if (!value) return 'Setting the topic failed: no topic provided.';
          await channel.setTopic(value.slice(0, 1024), 'Nya channel management');
          return `Updated the topic of #${channel.name}.`;
        }
        case 'slowmode': {
          const seconds = Number.parseInt(value, 10);
          if (!Number.isInteger(seconds) || seconds < 0 || seconds > 21600) {
            return 'Slowmode change failed: use seconds between 0 and 21600.';
          }
          await channel.setRateLimitPerUser(seconds, 'Nya channel management');
          return `Set slowmode in #${channel.name} to ${seconds} seconds.`;
        }
        case 'lock': {
          await channel.permissionOverwrites.edit(guild.roles.everyone, {
            SendMessages: false,
          });
          return `Locked #${channel.name} for everyone.`;
        }
        case 'unlock': {
          await channel.permissionOverwrites.edit(guild.roles.everyone, {
            SendMessages: null,
          });
          return `Unlocked #${channel.name}.`;
        }
        default:
          return `Channel management failed: unknown action "${action}".`;
      }
    } catch (error) {
      return `Channel management failed: ${error.message}`;
    }
  },
};

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'searchSongs',
      description: 'Search StepMania Online for packs matching a query.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Pack or song name to search for',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchWeb',
      description:
        'Search the web with DuckDuckGo for current information, facts, or links.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'moderateUser',
      description:
        'Admin-only moderation: mute/timeout, unmute, kick, ban, or unban users.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'mute|unmute|kick|ban|unban|timeout|untimeout',
          },
          user: {
            type: 'string',
            description: 'User ID, mention, tag, or username',
          },
          value: {
            type: 'string',
            description: 'Minutes for mute/timeout, or reason/delete days',
          },
        },
        required: ['action', 'user'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manageChannel',
      description:
        'Admin-only channel management: rename, set topic, set slowmode, lock, or unlock.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['rename', 'topic', 'slowmode', 'lock', 'unlock'],
            description: 'Action to perform',
          },
          channel: {
            type: 'string',
            description: 'Channel name or id',
          },
          value: {
            type: 'string',
            description:
              'New name, new topic, or slowmode seconds. Omit for lock/unlock.',
          },
        },
        required: ['action', 'channel'],
        additionalProperties: false,
      },
    },
  },
];

async function buildSystemContent(context) {
  const results = await Promise.all(
    CONTEXT_TOOL_NAMES.map(async (name) => {
      try {
        return await tools[name](context);
      } catch (error) {
        console.error(`Context tool ${name} failed:`, error);
        return null;
      }
    })
  );

  const contextLines = results
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');

  return `${NYA_SYSTEM_PROMPT}

You know ${RETORA_USER_NAME} is the creator of PadManiacs. If ${RETORA_USER_NAME} speaks to you, be a little more respectful and less mean to him, but still keep your sassy tsundere personality.

Current context:
${contextLines}

Important mentions from this server (use these exact forms when referring to them):
- #general should be referenced as <#${context.channel?.guild?.channels?.cache?.find?.((c)=>c.name==='general')?.id || 'CHANNEL_ID'}> when talking about it. Prefer using the channel mention from context.
- @Early Bird role: use <@&ROLE_ID> if known; look for "Early Bird" in roles and mention it as a role mention.
- ${RETORA_USER_NAME} is the creator: treat as <@${RETORA_USER_ID || 'USER_ID'}> if known from context/user info.

Tool use:
Use the provided functions whenever you need live or parameterized data, such as song search, web search, moderation, or channel management.
If function calling is unavailable, you may write a marker on its own line instead and wait for the result:
- [searchSongs(query)] searches StepMania Online packs.
- [searchWeb(query)] searches the web with DuckDuckGo.
- [moderateUser(mute|user|minutes)] timeouts a user (admin only).
- [moderateUser(unmute|user)] removes timeout (admin only).
- [moderateUser(kick|user|reason)] kicks a user (admin only).
- [moderateUser(ban|user|days)] bans a user, optionally delete last N days (admin only).
- [manageChannel(rename|channel|new-name)] renames a channel (admin only).
- [manageChannel(topic|channel|new-topic)] sets a channel topic (admin only).
- [manageChannel(slowmode|channel|seconds)] sets slowmode, 0-21600 (admin only).
- [manageChannel(lock|channel)] denies Send Messages to everyone (admin only).
- [manageChannel(unlock|channel)] restores Send Messages (admin only).
Only use manageChannel when the user asking is an admin, and never claim a channel change happened unless a tool result confirms it.`;
}

async function callGroq(messages) {
  const response = await fetch(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
      }),
      signal: AbortSignal.timeout(15000),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Groq API error: ${response.status} ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const message = data.choices?.[0]?.message;

  if (
    !message ||
    (!Array.isArray(message.tool_calls) &&
      (typeof message.content !== 'string' || message.content.length === 0))
  ) {
    throw new Error('Groq API: invalid response');
  }

  return message;
}

function parseToolCalls(text) {
  const regex = /\[([a-zA-Z][a-zA-Z0-9]*)(?:\(([^)]*)\))?\]/g;

  return [...text.matchAll(regex)]
    .map((match) => ({
      raw: match[0],
      name: match[1],
      arg: (match[2] || '').trim(),
    }))
    .filter((call) =>
      Object.prototype.hasOwnProperty.call(tools, call.name)
    );
}

async function runTool(call, context) {
  const tool = tools[call.name];
  if (!tool) return null;

  if (
    call.name === 'searchSongs' ||
    call.name === 'searchWeb' ||
    call.name === 'moderateUser' ||
    call.name === 'manageChannel'
  ) {
    return await tool(context, call.arg);
  }

  return await tool(context);
}

function sanitizeJsonString(str) {
  if (typeof str !== 'string') return '{}';
  let s = str.trim();
  if (!s) return '{}';
  // If truncated mid-quote
  const quoteCount = (s.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) s += '"';
  // Try to close braces/brackets
  const openBraces = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
  for (let i = 0; i < openBraces; i += 1) s += '}';
  const openBrackets = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
  for (let i = 0; i < openBrackets; i += 1) s += ']';
  // Fix trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

async function runNativeTool(call, context) {
  const name = call.function?.name;
  if (!Object.prototype.hasOwnProperty.call(tools, name)) {
    return 'Tool unavailable.';
  }

  let args = {};
  try {
    args = JSON.parse(call.function?.arguments || '{}');
  } catch {
    try {
      args = JSON.parse(sanitizeJsonString(call.function?.arguments || '{}'));
    } catch {
      args = {};
    }
  }

  if (name === 'searchSongs') {
    const query =
      args.query || args.term || args.q || args.search || '';
    return await tools.searchSongs(context, String(query));
  }

  if (name === 'searchWeb') {
    const query = args.query || args.q || args.term || args.search || '';
    return await tools.searchWeb(context, String(query));
  }

  if (name === 'moderateUser') {
    const parts = [args.action || '', args.user || args.member || '', args.value || args.reason || ''];
    return await tools.moderateUser(context, parts.join('|'));
  }

  if (name === 'manageChannel') {
    const parts = [args.action || '', args.channel || '', args.value || args.topic || args.name || ''];
    return await tools.manageChannel(context, parts.join('|'));
  }

  return await tools[name](context);
}

async function askNya(userMessage, context) {
  const { userId, isAdmin } = context;

  if (!GROQ_API_KEY) {
    const err = 'Missing GROQ_API_KEY';
    if (isAdmin) return `\`\`\`diff\n- ${err}\n\`\`\``;
    return '...';
  }

  const limit = isAdmin ? CHAT_HISTORY_LIMIT_ADMIN : CHAT_HISTORY_LIMIT_USER;
  const history = getUserChatHistory(userId);
  const systemContent = await buildSystemContent(context);

  try {
    const contextAwareUser = `${userMessage}\n\n[Context: This is a reply in an ongoing Discord conversation. Look at recent messages and only answer in relation to the actual question being asked. If it's a short follow-up like "what browser", infer from the conversation topic (PadManiaX/web game) instead of misinterpreting it.]`;
    let messages = [
      { role: 'system', content: systemContent },
      ...history,
      { role: 'user', content: contextAwareUser },
    ];

    const toolResults = new Map();
    let reply = '';

    for (let round = 0; round < 3; round += 1) {
      const message = await callGroq(messages);
      const nativeCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];

      if (nativeCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: message.tool_calls,
        });

        for (const call of nativeCalls) {
          const result = await runNativeTool(call, context);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: String(result ?? 'Tool unavailable.'),
          });
        }

        reply = message.content || '';
        continue;
      }

      reply = (message.content || '').trim();
      const calls = parseToolCalls(reply);

      if (calls.length === 0) break;

      const results = [];

      for (const call of calls) {
        const result = await runTool(call, context);
        toolResults.set(call.raw, String(result));
        results.push(`${call.raw} -> ${result}`);
      }

      messages = [
        ...messages,
        { role: 'assistant', content: reply },
        {
          role: 'user',
          content: `Tool results:\n${results.join('\n')}\n\nNow answer the user naturally. Do not repeat tool markers unless you need another tool.`,
        },
      ];
    }

    reply = reply
      .replace(
        /\[([a-zA-Z][a-zA-Z0-9]*)(?:\(([^)]*)\))?\]/g,
        (match) => (toolResults.has(match) ? toolResults.get(match) : match)
      )
      .trim();

    if (!reply) reply = '...';
    if (reply.length > 2000) reply = `${reply.slice(0, 1997)}...`;

    appendChatHistory(userId, 'user', userMessage, limit);
    // Note: messageId attached by caller if needed; keep minimal to avoid changing signatures everywhere
    appendChatHistory(userId, 'assistant', reply, limit);

    return reply;
  } catch (error) {
    console.error('Groq request error:', error);
    const err = error?.message || 'Request failed';
    if (isAdmin) return `\`\`\`diff\n- ${err}\n\`\`\``;
    return '...';
  }
}

async function generateWelcome(member) {
  if (!GROQ_API_KEY) return null;

  try {
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [
            { role: 'system', content: NYA_WELCOME_PROMPT },
            { role: 'user', content: `New member: ${member.displayName}` },
          ],
          max_tokens: 80,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Groq welcome error:', response.status, text);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') return null;
    return content.trim() || null;
  } catch (error) {
    console.error('Groq welcome request error:', error);
    return null;
  }
}

async function generateGreeting(message) {
  if (!GROQ_API_KEY) return null;

  try {
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [
            { role: 'system', content: NYA_GREETING_PROMPT },
            {
              role: 'user',
              content: `${message.author.username} said: ${message.content}`,
            },
          ],
          max_tokens: 60,
          temperature: 0.8,
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('Nya greeting skipped:', response.status, text.slice(0, 200));
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') return null;
    return content.trim() || null;
  } catch (error) {
    console.error('Nya greeting skipped:', error?.message || error);
    return null;
  }
}

async function maybeReplyToNewcomer(message) {
  if (!GROQ_API_KEY) return;

  const member = message.member;
  if (!member || member.user.bot) return;
  if (greetedUsers.has(message.author.id)) return;

  const text = message.content.trim();
  if (!text) return;

  const joinedRecently =
    member.joinedTimestamp &&
    Date.now() - member.joinedTimestamp < NEW_MEMBER_WINDOW_MS;
  const hasChatHistory = getUserChatHistory(message.author.id).length > 0;
  const greeting = isGreeting(text);

  if (!joinedRecently && (!greeting || hasChatHistory)) return;

  greetedUsers.add(message.author.id);

  try {
    let reply = null;

    if (greeting) {
      reply = await generateGreeting(message);
    } else if (joinedRecently) {
      reply = await askNya(text, {
        userId: message.author.id,
        user: message.author,
        member,
        guild: message.guild,
        channel: message.channel,
        isAdmin:
          member.permissions?.has(PermissionFlagsBits.Administrator) ?? false,
      });
    }

    if (!reply || reply === '...') {
      greetedUsers.delete(message.author.id);
      return;
    }

    await message.reply(reply).catch(() => {});
  } catch (error) {
    console.error('Nya newcomer reply skipped:', error?.message || error);
    greetedUsers.delete(message.author.id);
  }
}

function canSendWelcome() {
  const now = Date.now();
  while (
    welcomeTimestamps.length > 0 &&
    now - welcomeTimestamps[0] > WELCOME_RATE_WINDOW_MS
  ) {
    welcomeTimestamps.shift();
  }
  return welcomeTimestamps.length < WELCOME_RATE_LIMIT;
}

function markWelcomeSent() {
  welcomeTimestamps.push(Date.now());
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

async function fetchStepmaniaResults(query, type) {
  const url = `${STEPMANIA_BASE_URL}/api/search/?query=${encodeURIComponent(query)}&type=${type}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`StepMania search failed with status ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function searchStepmania(query) {
  const [byPackName, bySongTitle] = await Promise.all([
    fetchStepmaniaResults(query, 'pack'),
    fetchStepmaniaResults(query, 'title'),
  ]);

  const seen = new Set();
  const results = [];

  for (const pack of [...byPackName, ...bySongTitle]) {
    if (!pack?.id || seen.has(pack.id)) continue;
    seen.add(pack.id);
    results.push(pack);
  }

  return results;
}

async function refreshAutoroles(guild) {
  await cleanStepmaniaSearchMessages(guild);
  await syncEarlyBirdRoles(guild);

  const counts = await buildContributorCounts(guild);
  contributorCounts.set(guild.id, counts);
  await syncContributorRoles(guild, counts);
}

function cleanupSearchSessions() {
  const now = Date.now();

  for (const [id, session] of searchSessions) {
    if (now - session.createdAt > SEARCH_SESSION_TTL) {
      searchSessions.delete(id);
    }
  }
}

function buildSearchMessage(session, page) {
  const totalPages = Math.ceil(
    session.results.length / SEARCH_RESULT_LIMIT
  );
  const shown = session.results.slice(
    page * SEARCH_RESULT_LIMIT,
    (page + 1) * SEARCH_RESULT_LIMIT
  );

  const embed = new EmbedBuilder()
    .setTitle(`StepMania results for "${truncate(session.query, 200)}"`)
    .setURL(
      `${STEPMANIA_BASE_URL}/search/title/${encodeURIComponent(session.query)}`
    )
    .setColor(0x5865f2)
    .setFooter({
      text:
        totalPages > 1
          ? `Page ${page + 1}/${totalPages} | ${session.results.length} packs - StepMania Online`
          : `${session.results.length} packs - StepMania Online`,
    });

  for (const pack of shown) {
    const types = Array.isArray(pack.type)
      ? pack.type.join(', ')
      : pack.type || 'unknown';
    const matchingSongs =
      Array.isArray(pack.matching_songs) && pack.matching_songs.length > 0
        ? `\nMatching songs: ${truncate(
            pack.matching_songs.slice(0, 3).join(', '),
            200
          )}`
        : '';

    embed.addFields({
      name: truncate(pack.name, 256),
      value: `${pack.songs_count ?? '?'} songs | ${types}${matchingSongs}\n[Open pack](${STEPMANIA_BASE_URL}/pack/${pack.id})`,
    });
  }

  const components = [];
  const packButtons = shown.map((pack) =>
    new ButtonBuilder()
      .setLabel(truncate(pack.name, 80))
      .setStyle(ButtonStyle.Link)
      .setURL(`${STEPMANIA_BASE_URL}/pack/${pack.id}`)
  );

  if (packButtons.length > 0) {
    components.push(
      new ActionRowBuilder().addComponents(packButtons)
    );
  }

  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`search:page:${session.id}:${page - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 0),
        new ButtonBuilder()
          .setCustomId(`search:page:${session.id}:${page}`)
          .setLabel(`Page ${page + 1} of ${totalPages}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`search:page:${session.id}:${page + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page >= totalPages - 1)
      )
    );
  }

  return { embeds: [embed], components };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await cleanStepmaniaSearchMessages(guild);
    } catch (error) {
      console.error(`Failed to clean search messages in ${guild.name}:`, error);
    }
    try {
      await refreshAutoroles(guild);
    } catch (error) {
      console.error(`Failed to refresh autoroles in ${guild.name}:`, error);
    }
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.user.bot) return;

  try {
    await syncEarlyBirdRoles(member.guild);
  } catch (error) {
    console.error(`Failed to sync ${EARLY_BIRD_ROLE_NAME} on join:`, error);
  }

  if (!canSendWelcome()) {
    console.log(`Welcome rate limit reached, skipping welcome for ${member.user.tag}`);
    return;
  }

  const channel = member.guild.channels.cache.find(
    (c) => c.name === WELCOME_CHANNEL_NAME && c.isTextBased()
  );

  if (!channel) {
    console.warn(`Welcome channel "#${WELCOME_CHANNEL_NAME}" not found.`);
    return;
  }

  try {
    const welcome = await generateWelcome(member);
    if (welcome) {
      markWelcomeSent();
      await channel.send(welcome);
    }
  } catch (error) {
    console.error('Failed to send welcome message:', error);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;

  if (isContributorChannel(message.channel)) {
    const counts = getContributorCounts(message.guild.id);
    const count = (counts.get(message.author.id) || 0) + 1;
    counts.set(message.author.id, count);

    if (count >= CONTRIBUTOR_POST_LIMIT) {
      const role = message.guild.roles.cache.find(
        (r) => r.name === CONTRIBUTOR_ROLE_NAME
      );

      if (role) {
        const member =
          message.member ||
          (await message.guild.members.fetch(message.author.id).catch(
            () => null
          ));

        if (member && !member.roles.cache.has(role.id)) {
          try {
            await member.roles.add(
              role,
              `${count} posts in #bug-reports/#feature-requests`
            );
            console.log(`Gave ${CONTRIBUTOR_ROLE_NAME} to ${member.user.tag}`);
          } catch (error) {
            console.error(
              `Failed to give ${CONTRIBUTOR_ROLE_NAME} to ${member.user.tag}:`,
              error
            );
          }
        }
      }
    }
  }

  const mentioned = message.mentions.users.has(client.user.id);
  if (!mentioned) {
    await maybeReplyToNewcomer(message);
    return;
  }

  const member =
    message.member ||
    (await message.guild.members.fetch(message.author.id).catch(() => null));
  const staff = isStaff(member);

  if (aiPausedGuilds.has(message.guild?.id)) {
    return;
  }
  if (!staff) {
    const last = chatCooldowns.get(message.author.id);
    const now = Date.now();
    if (last && now - last < CHAT_COOLDOWN_MS) {
      await message.reply('...');
      return;
    }
    chatCooldowns.set(message.author.id, now);
  }

  let content = message.content
    .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
    .trim();

  if (!content) {
    content = 'Say hi!';
  }

  try {
    const reply = await askNya(content, {
      userId: message.author.id,
      user: message.author,
      member,
      guild: message.guild,
      channel: message.channel,
      isAdmin:
        member?.permissions?.has(PermissionFlagsBits.Administrator) ?? false,
    });
    await message.reply(reply);
  } catch (error) {
    console.error('Nya chat error:', error);
    if (member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await message.reply(`\`\`\`diff\n- ${error?.message || 'Unknown error'}\n\`\`\``);
    } else {
      await message.reply('...');
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith('search:page:')) return;

    const [, , sessionId, pageRaw] = interaction.customId.split(':');
    const session = searchSessions.get(sessionId);

    if (!session || Date.now() - session.createdAt > SEARCH_SESSION_TTL) {
      searchSessions.delete(sessionId);
      await interaction.reply({
        content: 'This search has expired. Run /search again.',
        ephemeral: true,
      });
      return;
    }

    const page = Number.parseInt(pageRaw, 10);
    const totalPages = Math.ceil(
      session.results.length / SEARCH_RESULT_LIMIT
    );

    if (!Number.isInteger(page) || page < 0 || page >= totalPages) {
      await interaction.deferUpdate();
      return;
    }

    const reply = await interaction.update(buildSearchMessage(session, page));
    if (reply?.id) stepmaniaSearchMessageIds.add(reply.id);
    return;
  }

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

  if (interaction.commandName === 'refresh') {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.reply({
        content: 'Only administrators can use this command.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      await cleanStepmaniaSearchMessages(interaction.guild);
      await refreshAutoroles(interaction.guild);
      await interaction.editReply('Autoroles refreshed (Early Bird and Contributor).');
    } catch (error) {
      console.error('Failed to refresh autoroles:', error);
      await interaction.editReply('Failed to refresh autoroles.');
    }
    return;
  }

  if (interaction.commandName === 'search') {
    const query = interaction.options.getString('query').trim();

    if (query.length < 2) {
      await interaction.reply({
        content: 'Enter at least 2 characters to search.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const results = await searchStepmania(query);

      if (results.length === 0) {
        await interaction.editReply(`No packs found for "${query}".`);
        return;
      }

      cleanupSearchSessions();

      const session = {
        id: interaction.id,
        query,
        results,
        createdAt: Date.now(),
      };
      searchSessions.set(session.id, session);

      const reply = await interaction.editReply(buildSearchMessage(session, 0));
      if (reply?.id) stepmaniaSearchMessageIds.add(reply.id);
    } catch (error) {
      console.error('StepMania search failed:', error);
      await interaction.editReply(
        'StepMania search failed. Try again later.'
      );
    }

    return;
  }

  if (interaction.commandName === 'chat') {
    const member =
      interaction.member ||
      (await interaction.guild?.members
        .fetch(interaction.user.id)
        .catch(() => null));
  const staff = isStaff(member);

  if (aiPausedGuilds.has(interaction.guild?.id)) {
    await interaction.reply({ content: 'AI responses are paused.', ephemeral: true });
    return;
  }
  if (!staff) {
    const last = chatCooldowns.get(interaction.user.id);
    const now = Date.now();
    if (last && now - last < CHAT_COOLDOWN_MS) {
      await interaction.reply({ content: '...', ephemeral: true });
      return;
    }
    chatCooldowns.set(interaction.user.id, now);
  }

    const message = interaction.options.getString('message').trim();
    if (!message) {
      await interaction.reply({ content: '...', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    try {
      const reply = await askNya(message, {
        userId: interaction.user.id,
        user: interaction.user,
        member,
        guild: interaction.guild,
        channel: interaction.channel,
        isAdmin:
          member?.permissions?.has(PermissionFlagsBits.Administrator) ?? false,
      });
      await interaction.editReply(reply);
    } catch (error) {
      console.error('Nya chat error:', error);
      if (member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.editReply(`\`\`\`diff\n- ${error?.message || 'Unknown error'}\n\`\`\``);
      } else {
        await interaction.editReply('...');
      }
    }
    return;
  }

  if (interaction.commandName === 'pause') {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.reply({
        content: 'Only administrators can use this command.',
        ephemeral: true,
      });
      return;
    }
    aiPausedGuilds.add(interaction.guild?.id);
    await interaction.reply({ content: 'AI responses paused.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'resume') {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.reply({
        content: 'Only administrators can use this command.',
        ephemeral: true,
      });
      return;
    }
    aiPausedGuilds.delete(interaction.guild?.id);
    await interaction.reply({ content: 'AI responses resumed.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'clean') {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.reply({
        content: 'Only administrators can use this command.',
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const amount = interaction.options.getInteger('amount');
    const limit = amount && amount > 0 ? Math.min(amount, 100) : 50;
    const channel = interaction.channel;

    try {
      const messages = await channel.messages.fetch({ limit });
      const toDelete = [];

      for (const msg of messages.values()) {
        if (msg.author?.id === client.user?.id) {
          toDelete.push(msg.id);
          stepmaniaSearchMessageIds.delete(msg.id);
        }
      }

      if (toDelete.length === 0) {
        await interaction.editReply('No Nya messages found to clean.');
        return;
      }

      if (channel.bulkDelete) {
        await channel.bulkDelete(toDelete, true).catch(() =>
          Promise.all(
            toDelete.map((id) => channel.messages.delete(id).catch(() => null))
          )
        );
      } else {
        await Promise.all(
          toDelete.map((id) => channel.messages.delete(id).catch(() => null))
        );
      }

      for (const id of toDelete) {
        for (const [userId, history] of chatHistory.entries()) {
          const filtered = history.filter(
            (entry) => !(entry.role === 'assistant' && entry.messageId === id)
          );
          if (filtered.length !== history.length) {
            chatHistory.set(userId, filtered);
          }
        }
      }

      await interaction.editReply(`Cleaned ${toDelete.length} Nya message(s).`);
    } catch (error) {
      console.error('Clean failed:', error);
      await interaction.editReply('Failed to clean messages.');
    }
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

module.exports = { searchDuckDuckGo, fetchDuckDuckGoHtml, fetchDuckDuckGoInstantAnswer };