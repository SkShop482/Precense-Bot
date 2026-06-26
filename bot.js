require('dotenv').config();
const {
  Client, GatewayIntentBits, SlashCommandBuilder,
  REST, Routes, PermissionFlagsBits, EmbedBuilder
} = require('discord.js');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CONFIG_FILE = './config.json';

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, '{}');
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}
function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ]
});

const commands = [
  new SlashCommandBuilder()
    .setName('config_presence')
    .setDescription('Définir le salon et le rôle à ping pour les appels de présence')
    .addChannelOption(opt =>
      opt.setName('salon')
        .setDescription('Le salon cible')
        .setRequired(true))
    .addRoleOption(opt =>
      opt.setName('role')
        .setDescription('Le rôle à mentionner lors de chaque appel (optionnel)')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('presence')
    .setDescription('Envoyer un appel de présence')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Le message / titre de la présence')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('date')
        .setDescription('La date (ex: 26/06/2026)')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('heure')
        .setDescription("L'heure (ex: 20:00)")
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Ping les membres du rôle configuré qui n\'ont pas réagi au dernier appel de présence')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
    console.log(`✅ Commandes enregistrées sur ${guildId}`);
  } catch (err) {
    console.error('Erreur enregistrement:', err);
  }
}

async function sendPresenceMessage(channel, message, date, heure, roleId) {
  const embed = new EmbedBuilder()
    .setTitle('📋 Appel de présence')
    .setDescription(`**${message}**`)
    .addFields(
      { name: '📅 Date', value: date, inline: true },
      { name: '🕐 Heure', value: heure, inline: true },
      { name: '\u200b', value: '✅ **Présent** · ❌ **Absent** · ⏳ **Retard**' }
    )
    .setColor(0x5865F2)
    .setTimestamp();

  const pingContent = roleId ? `<@&${roleId}>` : '';
  const msg = await channel.send({ content: pingContent || undefined, embeds: [embed] });
  await msg.react('✅');
  await msg.react('❌');
  await msg.react('⏳');
  return msg;
}

client.once('ready', async () => {
  console.log(`🤖 Connecté en tant que ${client.user.tag}`);
  for (const [, guild] of client.guilds.cache) {
    await registerCommands(guild.id);
  }
});

client.on('guildCreate', async (guild) => {
  await registerCommands(guild.id);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;
  const config = loadConfig();

  if (interaction.commandName === 'config_presence') {
    const salon = interaction.options.getChannel('salon');
    const role = interaction.options.getRole('role');
    if (!config[guildId]) config[guildId] = {};
    config[guildId].channelId = salon.id;
    config[guildId].roleId = role?.id ?? null;
    saveConfig(config);

    const roleText = role ? ` · Rôle pingé : ${role}` : ' · Aucun rôle configuré';
    await interaction.reply({ content: `✅ Salon configuré : ${salon}${roleText}`, ephemeral: true });
  }

  else if (interaction.commandName === 'presence') {
    const message = interaction.options.getString('message');
    const date = interaction.options.getString('date');
    const heure = interaction.options.getString('heure');

    const serverConfig = config[guildId];
    const channelId = serverConfig?.channelId;
    const roleId = serverConfig?.roleId ?? null;

    const targetChannel = channelId
      ? interaction.guild.channels.cache.get(channelId)
      : interaction.channel;

    if (!targetChannel) {
      return interaction.reply({ content: '❌ Salon introuvable. Refais `/config_presence`.', ephemeral: true });
    }

    const sentMsg = await sendPresenceMessage(targetChannel, message, date, heure, roleId);
    config[guildId].lastPresenceMsgId = sentMsg.id;
    config[guildId].lastPresenceChannelId = targetChannel.id;
    saveConfig(config);
    await interaction.reply({ content: `✅ Appel de présence envoyé dans ${targetChannel} !`, ephemeral: true });
  }

  else if (interaction.commandName === 'ping') {
    const serverConfig = config[guildId];
    const roleId = serverConfig?.roleId;
    const lastMsgId = serverConfig?.lastPresenceMsgId;
    const lastChannelId = serverConfig?.lastPresenceChannelId ?? serverConfig?.channelId;

    if (!roleId) {
      return interaction.reply({ content: '❌ Aucun rôle configuré. Utilise `/config_presence` d\'abord.', ephemeral: true });
    }
    if (!lastMsgId) {
      return interaction.reply({ content: '❌ Aucun appel de présence trouvé. Envoie d\'abord un `/presence`.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.guild.channels.cache.get(lastChannelId);
    if (!channel) {
      return interaction.editReply({ content: '❌ Salon introuvable.' });
    }

    let presenceMsg;
    try {
      presenceMsg = await channel.messages.fetch(lastMsgId);
    } catch {
      return interaction.editReply({ content: '❌ Message de présence introuvable (supprimé ?).' });
    }

    // Récupérer tous les membres du rôle
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      return interaction.editReply({ content: '❌ Rôle introuvable.' });
    }
    await interaction.guild.members.fetch();
    const roleMembers = role.members;

    // Récupérer les réactions ✅ et ⏳
    const reactions = presenceMsg.reactions.cache;
    const presentReaction = reactions.get('✅');
    const retardReaction = reactions.get('⏳');

    const reactedUsers = new Set();
    if (presentReaction) {
      const users = await presentReaction.users.fetch();
      users.forEach(u => reactedUsers.add(u.id));
    }
    if (retardReaction) {
      const users = await retardReaction.users.fetch();
      users.forEach(u => reactedUsers.add(u.id));
    }

    // Membres du rôle qui n'ont pas réagi
    const absents = roleMembers.filter(m => !reactedUsers.has(m.id) && !m.user.bot);

    if (absents.size === 0) {
      return interaction.editReply({ content: '✅ Tout le monde a répondu à l\'appel de présence !' });
    }

    const mentions = absents.map(m => `<@${m.id}>`).join(' ');
    await channel.send({ content: `⚠️ **Rappel de présence** — Les membres suivants n'ont pas encore répondu :\n${mentions}` });
    await interaction.editReply({ content: `✅ ${absents.size} membre(s) relancé(s) dans ${channel}.` });
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const config = loadConfig();
  const serverConfig = config[message.guildId];
  if (!serverConfig?.channelId) return;
  if (message.channelId !== serverConfig.channelId) return;
  if (!message.content.startsWith('!presence')) return;

  const parts = message.content.replace('!presence', '').trim().split('|');
  if (parts.length < 3) {
    return message.reply('❌ Format : `!presence <message> | <date> | <heure>`\nEx: `!presence Réunion gang | 26/06/2026 | 20:00`');
  }

  const [msg, date, heure] = parts.map(p => p.trim());
  const roleId = serverConfig?.roleId ?? null;
  const sentMsg = await sendPresenceMessage(message.channel, msg, date, heure, roleId);
  serverConfig.lastPresenceMsgId = sentMsg.id;
  serverConfig.lastPresenceChannelId = message.channel.id;
  saveConfig(config);
  await message.delete().catch(() => {});
});

client.login(TOKEN);
