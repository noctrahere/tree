'use strict';

const fs = require('node:fs');

// Load a local .env file when present. Real environment variables take priority.
try {
  const envFile = fs.readFileSync('.env', 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const BASE_URL = (process.env.LINKUP_URL || 'https://getlinkup.pages.dev').replace(/\/+$/, '');
const TOKEN = process.env.LINKUP_TOKEN;
const API = BASE_URL + '/api';

if (!TOKEN) {
  console.error('Missing LINKUP_TOKEN. Add your LinkupHQ bot token to the environment.');
  process.exit(1);
}

const headers = { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' };
let botInfo = null;
let stopping = false;
let streamController = null;

const DATA_FILE = process.env.TREE_DATA_FILE || './tree-data.json';
let serverSettings = {};
let databasePool = null;

async function initStorage() {
  if (!process.env.DB_HOST) {
    console.log('No DB_HOST configured; using local JSON storage.');
    try {
      serverSettings = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!serverSettings || typeof serverSettings !== 'object' || Array.isArray(serverSettings)) serverSettings = {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not load Tree settings:', error.message);
    }
    return;
  }

  const required = ['DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error('Missing MySQL environment variables: ' + missing.join(', '));

  const mysql = require('mysql2/promise');
  databasePool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 15000,
  });

  await databasePool.execute(`
    CREATE TABLE IF NOT EXISTS tree_server_settings (
      server_id VARCHAR(64) NOT NULL PRIMARY KEY,
      settings_json LONGTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [rows] = await databasePool.execute(
    'SELECT server_id, settings_json FROM tree_server_settings'
  );
  serverSettings = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.settings_json);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        serverSettings[row.server_id] = parsed;
      }
    } catch (error) {
      console.error('Could not parse settings for server ' + row.server_id + ':', error.message);
    }
  }
  console.log('🌳 MySQL connected; loaded settings for ' + rows.length + ' server(s).');
}

async function saveSettings(serverId) {
  if (databasePool) {
    await databasePool.execute(
      'INSERT INTO tree_server_settings (server_id, settings_json) VALUES (?, ?) ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)',
      [String(serverId), JSON.stringify(serverSettings[serverId] || {})]
    );
    return;
  }
  const tempFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(serverSettings, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function settingsFor(serverId) {
  if (!serverId) return null;
  if (!serverSettings[serverId]) serverSettings[serverId] = {};
  return serverSettings[serverId];
}
function optionText(options, name, fallback) {
  const value = getOption(options, name, fallback);
  if (value && typeof value === 'object') return value.id || value.value || value.name || fallback;
  return value;
}

async function api(path, options) {
  const response = await fetch(API + path, {
    ...(options || {}),
    headers: { ...headers, ...((options && options.headers) || {}) },
  });
  const bodyText = await response.text();
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
  if (!response.ok) {
    throw new Error('LinkupHQ API ' + response.status + ': ' + (body && body.error ? body.error : response.statusText));
  }
  return body;
}

async function postMessage(channelId, content) {
  return api('/channels/' + encodeURIComponent(channelId) + '/messages', {
    method: 'POST', body: JSON.stringify({ content: String(content).slice(0, 4000) }),
  });
}

async function reply(interactionId, content, ephemeral) {
  return api('/interactions/' + encodeURIComponent(interactionId) + '/reply', {
    method: 'POST',
    body: JSON.stringify({ content: String(content).slice(0, 4000), ephemeral: ephemeral !== false }),
  });
}

const commands = [
  { name: 'help', description: 'Show Tree commands' },
  { name: 'ping', description: 'Check whether Tree is responding' },
  { name: 'echo', description: 'Make Tree repeat a message', options: [{ name: 'text', description: 'The message Tree should repeat', required: true }] },
  { name: 'roll', description: 'Roll a dice', options: [{ name: 'sides', description: 'Number of sides (default 6)', required: false }] },
  { name: 'setup', description: 'Open this server’s Tree setup panel' },
  { name: 'about', description: 'Learn about Tree' },
  { name: 'server', description: 'Show the current server information' },
  { name: 'welcome-set', description: 'Set this server’s welcome channel', options: [{ name: 'channel', description: 'Channel ID for welcome messages', required: true }] },
  { name: 'welcome-off', description: 'Disable welcome messages in this server' },
  { name: 'welcome-test', description: 'Preview this server’s welcome message' },
  { name: 'goodbye-set', description: 'Set this server’s goodbye channel', options: [{ name: 'channel', description: 'Channel ID for goodbye messages', required: true }] },
  { name: 'logs-set', description: 'Set this server’s activity log channel', options: [{ name: 'channel', description: 'Channel ID for logs', required: true }] },
  { name: 'logs-off', description: 'Disable activity logging in this server' },
  { name: 'logs-test', description: 'Send a test log message' },
  { name: 'announce', description: 'Send an announcement to a channel', options: [{ name: 'channel', description: 'Destination channel ID', required: true }, { name: 'text', description: 'Announcement text', required: true }] },
  { name: 'react', description: 'Toggle a reaction on a message', options: [{ name: 'message', description: 'Message ID', required: true }, { name: 'emoji', description: 'Emoji to react with', required: true }] },
  { name: 'pin', description: 'Pin a message', options: [{ name: 'message', description: 'Message ID', required: true }] },
  { name: 'unpin', description: 'Unpin a message', options: [{ name: 'message', description: 'Message ID', required: true }] },
  { name: 'history', description: 'Show recent messages in a channel', options: [{ name: 'channel', description: 'Channel ID', required: true }, { name: 'limit', description: 'Number of messages (1–20)', required: false }] },
  { name: 'edit', description: 'Edit a message sent by Tree', options: [{ name: 'message', description: 'Message ID', required: true }, { name: 'text', description: 'New message text', required: true }] },
  { name: 'delete', description: 'Delete a message (own message or Manage Messages)', options: [{ name: 'message', description: 'Message ID', required: true }] },
  { name: 'purge', description: 'Delete recent messages in a channel (requires Manage Messages)', options: [{ name: 'channel', description: 'Channel ID', required: true }, { name: 'limit', description: 'How many recent messages (1–20)', required: true }] },
  { name: 'goodbye-off', description: 'Disable goodbye messages in this server' },
];

function getOption(options, name, fallback) {
  if (!options || typeof options !== 'object') return fallback;
  return options[name] === undefined || options[name] === null ? fallback : options[name];
}

function displayName(user) {
  if (!user) return 'Someone';
  return user.displayName || user.username || user.name || user.id || 'Someone';
}

async function handleInteraction(event) {
  const command = String(event.command || '').replace(/^\//, '').toLowerCase();
  const options = event.options || {};
  try {
    switch (command) {
      case 'ping':
        await reply(event.id, '🏓 Pong! Tree is online and responding.', true);
        break;
      case 'help':
        await reply(event.id,
          '🌳 **Tree — All-in-one LinkupHQ bot**\n' +
          '/help — Show commands\n/ping — Check bot status\n/echo text — Repeat a message\n' +
          '/roll sides — Roll a dice\n/about — About Tree\n/server — Server information\n\n' +
          '/welcome-set, /welcome-off — Configure welcome messages\n/goodbye-set, /goodbye-off — Configure departure messages\n' +
          '/logs-set, /logs-off, /logs-test — Configure activity logs\n/announce channel text — Send an announcement\n' +
          '/react message emoji — Toggle a reaction\n/pin message and /unpin message — Manage pins', true);
        break;
      case 'echo': {
        const text = String(getOption(options, 'text', event.text || '')).trim();
        await reply(event.id, text ? text.slice(0, 1900) : 'Please provide some text.', true);
        break;
      }
      case 'roll': {
        const rawSides = Number(getOption(options, 'sides', 6));
        const sides = Number.isFinite(rawSides) ? Math.floor(rawSides) : 6;
        if (sides < 2 || sides > 1000000) {
          await reply(event.id, 'Choose between 2 and 1,000,000 sides.', true);
          break;
        }
        const result = Math.floor(Math.random() * sides) + 1;
        await reply(event.id, '🎲 You rolled **' + result + '** (1–' + sides + ').', true);
        break;
      }
      case 'welcome-set': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        const channelId = String(optionText(options, 'channel', '')).trim().replace(/[<#>]/g, '');
        if (!/^\d{5,30}$/.test(channelId)) {
          await reply(event.id, 'Please provide a valid channel ID (or mention the channel).', true);
          break;
        }
        const settings = settingsFor(event.serverId);
        settings.welcomeChannelId = channelId;
        await saveSettings(event.serverId);
        await reply(event.id, '🌳 Welcome messages are now enabled in <#' + channelId + '> for this server.', true);
        break;
      }
      case 'welcome-off': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        const settings = settingsFor(event.serverId);
        delete settings.welcomeChannelId;
        await saveSettings(event.serverId);
        await reply(event.id, 'Welcome messages have been disabled for this server.', true);
        break;
      }
      case 'welcome-test': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        const settings = settingsFor(event.serverId);
        if (!settings || !settings.welcomeChannelId) {
          await reply(event.id, 'No welcome channel is configured. Use /welcome-set first.', true);
          break;
        }
        await postMessage(settings.welcomeChannelId, '🌳 Welcome! This is a preview of Tree’s welcome message.');
        await reply(event.id, 'Sent a welcome preview.', true);
        break;
      }
      case 'goodbye-set': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        const channelId = String(optionText(options, 'channel', '')).trim().replace(/[<#>]/g, '');
        if (!/^\d{5,30}$/.test(channelId)) {
          await reply(event.id, 'Please provide a valid channel ID (or mention the channel).', true);
          break;
        }
        settingsFor(event.serverId).goodbyeChannelId = channelId;
        await saveSettings(event.serverId);
        await reply(event.id, '🌳 Goodbye messages are now enabled in <#' + channelId + '> for this server.', true);
        break;
      }
      case 'goodbye-off': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        delete settingsFor(event.serverId).goodbyeChannelId;
        await saveSettings(event.serverId);
        await reply(event.id, 'Goodbye messages have been disabled for this server.', true);
        break;
      }
      case 'logs-set': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        const channelId = String(optionText(options, 'channel', '')).trim().replace(/[<#>]/g, '');
        if (!/^\d{5,30}$/.test(channelId)) {
          await reply(event.id, 'Please provide a valid channel ID (or mention the channel).', true);
          break;
        }
        settingsFor(event.serverId).logChannelId = channelId;
        await saveSettings(event.serverId);
        await reply(event.id, '📋 Activity logging is now enabled in <#' + channelId + '>.', true);
        break;
      }
      case 'logs-off': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        delete settingsFor(event.serverId).logChannelId;
        await saveSettings(event.serverId);
        await reply(event.id, 'Activity logging has been disabled for this server.', true);
        break;
      }
      case 'logs-test': {
        if (!event.serverId) { await reply(event.id, 'This command can only be used inside a server.', true); break; }
        const settings = settingsFor(event.serverId);
        if (!settings.logChannelId) { await reply(event.id, 'No log channel is configured. Use /logs-set first.', true); break; }
        await postMessage(settings.logChannelId, '📋 **Tree logging test** — activity logs are configured correctly.');
        await reply(event.id, 'Sent a test log message.', true);
        break;
      }
      case 'announce': {
        const channelId = String(optionText(options, 'channel', '')).trim().replace(/[<#>]/g, '');
        const text = String(getOption(options, 'text', '')).trim();
        if (!/^\d{5,30}$/.test(channelId) || !text) {
          await reply(event.id, 'Provide a valid channel and announcement text.', true);
          break;
        }
        await postMessage(channelId, '📢 **Announcement**\n' + text);
        await reply(event.id, 'Announcement sent to <#' + channelId + '>.', true);
        break;
      }
      case 'react': {
        const messageId = String(getOption(options, 'message', '')).trim();
        const emoji = String(getOption(options, 'emoji', '')).trim();
        if (!/^\d{5,30}$/.test(messageId) || !emoji || emoji.length > 100) {
          await reply(event.id, 'Provide a valid message ID and emoji.', true);
          break;
        }
        await api('/messages/' + encodeURIComponent(messageId) + '/reactions', {
          method: 'PUT', body: JSON.stringify({ emoji }),
        });
        await reply(event.id, 'Added/toggled ' + emoji + ' on that message.', true);
        break;
      }
      case 'pin':
      case 'unpin': {
        const messageId = String(getOption(options, 'message', '')).trim();
        if (!/^\d{5,30}$/.test(messageId)) {
          await reply(event.id, 'Please provide a valid message ID.', true);
          break;
        }
        await api('/messages/' + encodeURIComponent(messageId) + '/pin', {
          method: 'PUT', body: JSON.stringify({ pinned: command === 'pin' }),
        });
        await reply(event.id, command === 'pin' ? '📌 Message pinned.' : 'Message unpinned.', true);
        break;
      }
      case 'history': {
        const channelId = String(optionText(options, 'channel', '')).trim().replace(/[<#>]/g, '');
        const rawLimit = Number(getOption(options, 'limit', 10));
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, Math.floor(rawLimit))) : 10;
        if (!/^\d{5,30}$/.test(channelId)) { await reply(event.id, 'Please provide a valid channel.', true); break; }
        const result = await api('/channels/' + encodeURIComponent(channelId) + '/messages?limit=' + limit);
        const messages = Array.isArray(result) ? result : (result && Array.isArray(result.messages) ? result.messages : []);
        if (!messages.length) { await reply(event.id, 'No messages were returned. Check Tree can view the channel and read message history.', true); break; }
        const lines = messages.slice(0, limit).map((m) => {
          const author = m.authorId || 'Unknown user';
          const content = String(m.content || '[message content unavailable]').replace(/\s+/g, ' ').slice(0, 180);
          return '• `' + author + '` — ' + content;
        });
        await reply(event.id, '🕘 **Recent messages in <#' + channelId + '>**\n' + lines.join('\n'), true);
        break;
      }
      case 'edit': {
        const messageId = String(getOption(options, 'message', '')).trim();
        const content = String(optionText(options, 'text', '')).trim();
        if (!/^\d{5,30}$/.test(messageId) || !content) { await reply(event.id, 'Provide a valid message ID and new text.', true); break; }
        await api('/messages/' + encodeURIComponent(messageId), { method: 'PATCH', body: JSON.stringify({ content: content.slice(0, 4000) }) });
        await reply(event.id, '✏️ Tree message edited.', true);
        break;
      }
      case 'delete': {
        const messageId = String(getOption(options, 'message', '')).trim();
        if (!/^\d{5,30}$/.test(messageId)) { await reply(event.id, 'Please provide a valid message ID.', true); break; }
        await api('/messages/' + encodeURIComponent(messageId), { method: 'DELETE' });
        await reply(event.id, '🗑️ Message deleted.', true);
        break;
      }
      case 'purge': {
        const channelId = String(optionText(options, 'channel', '')).trim().replace(/[<#>]/g, '');
        const rawLimit = Number(getOption(options, 'limit', 0));
        const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 0;
        if (!/^\d{5,30}$/.test(channelId) || limit < 1 || limit > 20) {
          await reply(event.id, 'Provide a valid channel and a limit from 1 to 20.', true);
          break;
        }
        const result = await api('/channels/' + encodeURIComponent(channelId) + '/messages?limit=' + limit);
        const messages = Array.isArray(result) ? result : (result && Array.isArray(result.messages) ? result.messages : []);
        let deleted = 0;
        for (const message of messages.slice(0, limit)) {
          if (!message || !message.id) continue;
          try {
            await api('/messages/' + encodeURIComponent(message.id), { method: 'DELETE' });
            deleted++;
          } catch (error) {
            console.warn('Could not delete message ' + message.id + ': ' + error.message);
          }
        }
        await reply(event.id, '🧹 Deleted ' + deleted + ' of ' + Math.min(messages.length, limit) + ' requested messages. Tree needs Manage Messages to delete other members’ messages.', true);
        break;
      }
      case 'setup': {
        if (!event.serverId) {
          await reply(event.id, '⚙️ The setup panel can only be opened inside a server.', true);
          break;
        }
        const settings = serverSettings[event.serverId] || {};
        const channel = (id) => id ? '<#' + id + '>  `' + id + '`' : '`Not set`';
        const panel =
          '⚙️ **Tree Setup**\n' +
          'Server-specific configuration for **' + (event.serverName || 'this server') + '**.\n' +
          'Changes made here apply only to this server.\n\n' +
          '👋 **WELCOME**\n' +
          'Channel: ' + channel(settings.welcomeChannelId) + '\n' +
          'Commands: `/welcome-set`, `/welcome-test`, `/welcome-off`\n\n' +
          '🚪 **GOODBYE**\n' +
          'Channel: ' + channel(settings.goodbyeChannelId) + '\n' +
          'Commands: `/goodbye-set`, `/goodbye-off`\n\n' +
          '📋 **ACTIVITY LOGS**\n' +
          'Channel: ' + channel(settings.logChannelId) + '\n' +
          'Commands: `/logs-set`, `/logs-off`, `/logs-test`\n\n' +
          '✅ **VERIFICATION**\n' +
          '⚪ Not available yet\n\n' +
          '🎫 **TICKETS**\n' +
          '⚪ Not available yet\n\n' +
          '🎁 **GIVEAWAYS**\n' +
          '⚪ Not available yet\n\n' +
          '👥 **ROLES / AUTOROLE**\n' +
          '⚪ Not available yet\n\n' +
          '📈 **LEVELING**\n' +
          '⚪ Not available yet\n\n' +
          '🌳 Use `/setup` again to view the latest settings.';
        await reply(event.id, panel, true);
        break;
      }
      case 'about':
        await reply(event.id, '🌳 **Tree** is an all-in-one LinkupHQ bot, built to bring useful server tools together in one place.', true);
        break;
      case 'server': {
        const server = botInfo && Array.isArray(botInfo.servers)
          ? botInfo.servers.find(function (item) { return item.id === event.serverId; }) : null;
        if (!server) {
          await reply(event.id, 'I could not find this server in my bot information.', true);
          break;
        }
        const channelCount = Array.isArray(server.channels) ? server.channels.length : 0;
        await reply(event.id, '🏡 **' + (server.name || 'Server') + '**\nServer ID: ' + server.id +
          '\nChannels visible to Tree: ' + channelCount, true);
        break;
      }
      default:
        await reply(event.id, 'I do not recognize that command. Try /help.', true);
    }
  } catch (error) {
    console.error('Command failed (' + command + '):', error.message);
    try { await reply(event.id, 'Something went wrong while running that command. Please try again.', true); }
    catch (replyError) { console.error('Could not send interaction error:', replyError.message); }
  }
}

async function handleEvent(name, event) {
  if (name === 'ready') {
    console.log('🌳 Tree connected to the LinkupHQ event stream.');
    return;
  }
  if (name === 'message_create' || name === 'message_update') {
    if (botInfo && botInfo.user && event.authorId === botInfo.user.id) return;
    const serverId = findServerForChannel(event.channelId);
    const actor = event.authorId ? '`' + event.authorId + '`' : 'Unknown member';
    const label = name === 'message_create' ? '📝 **Message sent**' : '✏️ **Message edited**';
    await writeActivityLog(serverId, event.channelId, label + ' in <#' + event.channelId + '> by ' + actor + '.');
    return;
  }
  if (name === 'message_delete') {
    const serverId = findServerForChannel(event.channelId);
    await writeActivityLog(serverId, event.channelId,
      '🗑️ **Message deleted** in <#' + event.channelId + '>. Message ID: `' + (event.id || 'unknown') + '`');
    return;
  }
  if (name === 'interaction_create') {
    await handleInteraction(event);
    return;
  }
  if (name === 'member_join') {
    const user = event.user || {};
    const nameText = displayName(user);
    const serverId = event.serverId;
    console.log('Member joined:', nameText, 'in server', serverId || 'unknown');
    const settings = serverId && serverSettings[serverId];
    if (settings && settings.welcomeChannelId) {
      try {
        await postMessage(settings.welcomeChannelId, '🌳 Welcome to the server, **' + nameText.replace(/[@\\*_~`|]/g, '') + '**! We’re glad you’re here.');
      } catch (error) {
        console.error('Could not send welcome message for server ' + serverId + ':', error.message);
      }
    }
    await writeActivityLog(serverId, null, '👋 **Member joined:** ' + nameText.replace(/[@\\*_~`|]/g, ''));
  }
  if (name === 'member_leave') {
    const user = event.user || {};
    const nameText = Object.keys(user).length ? displayName(user) : (event.userId || 'A member');
    const serverId = event.serverId;
    console.log('Member left:', nameText, 'in server', serverId || 'unknown');
    const settings = serverId && serverSettings[serverId];
    if (settings && settings.goodbyeChannelId) {
      try {
        await postMessage(settings.goodbyeChannelId, '👋 **' + nameText.replace(/[@\\*_~`|]/g, '') + '** has left the server.');
      } catch (error) {
        console.error('Could not send goodbye message for server ' + serverId + ':', error.message);
      }
    }
    await writeActivityLog(serverId, null, '🚪 **Member left:** ' + nameText.replace(/[@\\*_~`|]/g, ''));
  }
  if (name === 'server_join') {
    console.log('Tree was added to a server:', event.name || event.id || 'unknown');
  }
}

function findServerForChannel(channelId) {
  if (!botInfo || !Array.isArray(botInfo.servers)) return null;
  for (const server of botInfo.servers) {
    if (Array.isArray(server.channels) && server.channels.some((channel) => channel.id === channelId)) return server.id;
  }
  return null;
}

async function writeActivityLog(serverId, channelId, content) {
  const settings = serverId && serverSettings[serverId];
  if (!settings || !settings.logChannelId || settings.logChannelId === channelId) return;
  try {
    await postMessage(settings.logChannelId, content);
  } catch (error) {
    console.error('Could not write activity log for server ' + serverId + ':', error.message);
  }
}

function parseSSEBlock(block) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try { return { eventName, data: JSON.parse(dataLines.join('\n')) }; }
  catch (error) {
    console.error('Could not parse event data:', error.message);
    return null;
  }
}

async function connectStream() {
  let retryDelay = 1000;
  while (!stopping) {
    streamController = new AbortController();
    try {
      console.log('Connecting to LinkupHQ event stream...');
      const response = await fetch(API + '/stream', {
        headers: { Authorization: 'Bot ' + TOKEN, Accept: 'text/event-stream' },
        signal: streamController.signal,
      });
      if (!response.ok || !response.body) throw new Error('Stream request failed: HTTP ' + response.status);
      retryDelay = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopping) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const block = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
          buffer = buffer.slice(boundary + separator.length);
          const parsed = parseSSEBlock(block);
          if (parsed) {
            try { await handleEvent(parsed.eventName, parsed.data); }
            catch (error) { console.error('Event handler failed:', error.message); }
          }
        }
      }
      if (!stopping) console.warn('LinkupHQ stream disconnected.');
    } catch (error) {
      if (!stopping) console.error('Stream connection error:', error.message);
    }
    if (!stopping) {
      console.log('Reconnecting in ' + Math.round(retryDelay / 1000) + 's...');
      await new Promise(function (resolve) { setTimeout(resolve, retryDelay); });
      retryDelay = Math.min(retryDelay * 2, 30000);
    }
  }
}

function startTerminalCommands() {
  // Hosting panels often provide stdin without marking it as a TTY.
  if (!process.stdin || !process.stdin.readable) {
    console.warn('Console input is unavailable in this hosting environment.');
    return;
  }
  const readline = require('node:readline');
  const terminal = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  console.log('\n🌳 Tree console commands (prefix ! is optional):');
  console.log('  help                         Show this help');
  console.log('  status                       Show connection and server status');
  console.log('  servers                      List servers Tree is in');
  console.log('  channels <server_id>         List channels in a server');
  console.log('  say <channel_id> <message>   Send a message to a channel');
  console.log('  dm <dm_channel_id> <message> Send to an existing DM channel');
  console.log('  refresh                      Refresh server/channel list from Linkup');

  let commandBusy = false;
  terminal.on('line', async function (line) {
    const input = line.trim().replace(/^!/, '');
    if (!input) return;
    if (commandBusy) { console.log('A console command is still running; please wait.'); return; }

    const firstSpace = input.search(/\s/);
    const command = (firstSpace === -1 ? input : input.slice(0, firstSpace)).toLowerCase();
    const args = firstSpace === -1 ? '' : input.slice(firstSpace).trim();

    if (command === 'help') {
      console.log('Commands: help | status | servers | channels <server_id> | say <channel_id> <message> | dm <dm_channel_id> <message> | refresh');
      console.log('Example: say 123456789012345678 Hello from Tree!');
      console.log('DM note: Linkup API docs do not describe creating/opening a DM. dm requires an existing DM channel ID.');
      return;
    }
    if (command === 'status') {
      console.log('Bot: ' + (botInfo ? 'authenticated' : 'not authenticated'));
      console.log('Stream: ' + (streamController && !streamController.signal.aborted ? 'connected/connecting' : 'not connected'));
      console.log('Servers: ' + (botInfo && Array.isArray(botInfo.servers) ? botInfo.servers.length : 0));
      console.log('Storage: ' + (databasePool ? 'MySQL' : 'local JSON'));
      return;
    }
    if (command === 'servers') {
      const servers = botInfo && Array.isArray(botInfo.servers) ? botInfo.servers : [];
      if (!servers.length) { console.log('No servers returned by Linkup.'); return; }
      for (const server of servers) console.log('- ' + (server.name || 'Unnamed server') + ' | ID: ' + server.id);
      return;
    }
    if (command === 'channels') {
      const serverId = args.split(/\s+/)[0];
      const server = botInfo && Array.isArray(botInfo.servers)
        ? botInfo.servers.find((item) => String(item.id) === String(serverId)) : null;
      if (!server) { console.log('Server not found. Run "servers" to list IDs.'); return; }
      const channels = Array.isArray(server.channels) ? server.channels : [];
      if (!channels.length) { console.log('No channels visible to Tree in this server.'); return; }
      for (const channel of channels) console.log('- #' + (channel.name || 'unnamed') + ' | ' + (channel.type || 'channel') + ' | ID: ' + channel.id);
      return;
    }
    if (command === 'refresh') {
      commandBusy = true;
      try {
        botInfo = await api('/bot/me');
        console.log('Refreshed. Tree is in ' + (Array.isArray(botInfo.servers) ? botInfo.servers.length : 0) + ' server(s).');
      } catch (error) { console.error('Refresh failed:', error.message); }
      finally { commandBusy = false; }
      return;
    }
    if (command === 'say' || command === 'dm') {
      const match = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        console.log(command === 'dm' ? 'Usage: dm <existing_dm_channel_id> <message>' : 'Usage: say <channel_id> <message>');
        return;
      }
      const channelId = match[1].replace(/[<#>]/g, '');
      const message = match[2].trim();
      if (!/^\d{5,30}$/.test(channelId)) { console.log('Invalid channel ID.'); return; }
      if (!message) { console.log('Please include a message.'); return; }
      commandBusy = true;
      try {
        await postMessage(channelId, message);
        console.log('🌳 Message sent to ' + (command === 'dm' ? 'DM channel ' : 'channel ') + channelId + '.');
      } catch (error) { console.error('Could not send message:', error.message); }
      finally { commandBusy = false; }
      return;
    }
    console.log('Unknown command. Type help.');
  });
  process.stdin.resume();
}
async function start() {
  console.log('🌳 Starting Tree...');
  await initStorage();
  startTerminalCommands();
  botInfo = await api('/bot/me');
  if (!botInfo || !botInfo.app || !botInfo.app.id) {
    throw new Error('The /api/bot/me response did not include app.id. Check your token and LinkupHQ URL.');
  }
  console.log('Authenticated as ' + ((botInfo.user && (botInfo.user.username || botInfo.user.displayName)) || botInfo.app.name || 'Tree'));
  console.log('Connected servers: ' + (Array.isArray(botInfo.servers) ? botInfo.servers.length : 0));
  await api('/apps/' + encodeURIComponent(botInfo.app.id) + '/commands', {
    method: 'PUT', body: JSON.stringify({ commands }),
  });
  console.log('Registered ' + commands.length + ' slash commands.');
  await connectStream();
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log('\nReceived ' + signal + '. Shutting down Tree...');
  if (streamController) streamController.abort();
  if (databasePool) databasePool.end().catch((error) => console.error('MySQL shutdown error:', error.message));
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });

start().catch(function (error) {
  console.error('Tree could not start:', error.message);
  process.exitCode = 1;
});
