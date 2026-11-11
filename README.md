# Tree 🌳

Tree is an all-in-one bot for LinkupHQ. This is the first runnable foundation, built with Node.js 18+ and no third-party packages.

## Features in this starter

- Connects to the LinkupHQ live Server-Sent Events stream
- Automatically reconnects if the stream disconnects
- Registers slash commands at startup
- /help — command list
- /ping — check that Tree is responding
- /echo — repeat supplied text
- /roll — roll a dice
- /about — information about Tree
- /server — show server details
- Per-server welcome channels with `/welcome-set`, `/welcome-off` and `/welcome-test`
- Per-server goodbye channels with `/goodbye-set` and `/goodbye-off`
- Automatically sends a welcome message when a member joins (Server Members intent required)
- Stores each server’s settings separately in `tree-data.json`

## Requirements

- Node.js 18 or newer
- A LinkupHQ application and bot token
- The bot invited to a server

## Run locally

1. Download or clone this repository.
2. Copy .env.example to .env.
3. Put your real bot token in .env.
4. Set LINKUP_URL to the LinkupHQ site URL you use.
5. Run node bot.js.

The project intentionally has no dependencies. Node.js provides the HTTP and streaming APIs used by the bot.

For macOS/Linux, you can also start it with environment variables:

    LINKUP_TOKEN=lu.your_token LINKUP_URL=https://getlinkup.pages.dev node bot.js

For Windows PowerShell:

    $env:LINKUP_TOKEN="lu.your_token"
    $env:LINKUP_URL="https://getlinkup.pages.dev"
    node bot.js

## Hosting

Use a Node.js host that supports long-running processes and outbound HTTPS connections. Set these environment variables in the host dashboard:

- LINKUP_TOKEN — your bot token
- LINKUP_URL — your LinkupHQ site URL

Set the start command to npm start or node bot.js. Do not use a serverless function or a host that sleeps, because Tree must keep its event stream open to appear online.

## LinkupHQ setup

In the Developer Portal:

1. Open Tree's Bot settings.
2. Enable Server Members intent if you want join events and welcome messages.
3. Enable Message Content only if you later add message-reading features.
4. Invite Tree with the permissions it needs. For this starter, it needs View Channels and Send Messages.

Tree is designed to be installed in multiple servers. Each server has its own welcome channel. In a server, run `/welcome-set` and provide the channel ID (or channel mention), `/welcome-test` to preview it, and `/welcome-off` to disable it. Configure departure messages with `/goodbye-set` and disable them with `/goodbye-off`. Enable the Server Members intent in the LinkupHQ Developer Portal for join events. Settings are stored in `tree-data.json` on the bot host; keep that file on persistent storage when deploying so settings survive restarts and redeployments.

## Important API limitations

This starter only implements actions documented by the LinkupHQ Bot API. The currently documented reference covers slash commands, messages, reactions, pins, typing and events. It does not document dedicated endpoints for ban, kick, timeout, role assignment, ticket creation or poll creation, so those features are not falsely advertised as working yet.

## Security

- Never commit .env.
- Never paste your bot token into GitHub, issues, screenshots or chat.
- If a token is exposed, reset it in the LinkupHQ Developer Portal immediately.
