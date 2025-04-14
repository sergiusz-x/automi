# Installation Guide

[← Back to main README](../README.md#-documentation)

This guide covers the installation and configuration process for both the Automi Controller and Agents.

## Prerequisites

Before installing Automi, ensure you have the following:

- **Node.js v22+**: Required for both Controller and Agents
- **Python 3.6+**: For running Python scripts on agent machines
- **MySQL Database**: For the Controller
- **Discord Bot**: Create a bot via the [Discord Developer Portal](https://discord.com/developers/applications)

## Controller Installation

### 1. Clone or download the Automi repository

```bash
git clone https://github.com/sergiusz-x/automi.git
cd automi/controller
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure the Controller

Create a configuration file by copying the template:

```bash
cp config.template.json config.json
```

Edit the `config.json` file with your settings:

```json
{
    "app": {
        "port": 3000
    },
    "websocket": {
        "port": 4000,
        "useSSL": false,
        "sslCertPath": "./certs/cert.pem",
        "sslKeyPath": "./certs/key.pem",
        "security": {
            "maxConnectionsPerWindow": 5,
            "rateLimitWindowMs": 60000,
            "blacklistedIPs": [],
            "allowedOrigins": [],
            "requireUserAgent": true
        }
    },
    "database": {
        "host": "localhost",
        "port": 3306,
        "username": "YOUR_DATABASE_USERNAME",
        "password": "YOUR_DATABASE_PASSWORD",
        "name": "automi"
    },
    "discord": {
        "botToken": "YOUR_DISCORD_BOT_TOKEN",
        "clientId": "YOUR_DISCORD_CLIENT_ID",
        "guildId": "YOUR_DISCORD_GUILD_ID",
        "webhookUrl": "YOUR_DISCORD_WEBHOOK_URL"
    }
}
```

### 4. Create the MySQL database

```sql
CREATE DATABASE automi CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
```

### 5. Start the Controller

```bash
node index.js
```

After starting the Controller, use your Discord bot to register a new agent using the command:

```
/agent add id:agent-001 ip:*
```

This will generate the necessary authentication token that you will need to configure your agent in the next steps.

## Agent Installation

### 1. Navigate to the agent directory

```bash
cd automi/agent
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure the Agent

Create a configuration file by copying the template:

```bash
cp config.template.json config.json
```

Edit the `config.json` file:

```json
{
    "agentId": "unique-agent-id",
    "token": "secure-token-matching-controller-config",
    "controllerUrl": "ws://localhost:4000"
}
```

Where:
- `agentId`: A unique identifier for this agent
- `token`: A secure token that matches the one registered in the controller
- `controllerUrl`: The WebSocket URL of your controller

### 4. Start the Agent

```bash
node index.js
```

## Discord Bot Setup

1. Create a new application in the [Discord Developer Portal](https://discord.com/developers/applications)
2. Add a Bot to your application and copy the token
3. Enable necessary intents (Server Members, Message Content)
4. Add your bot to your server using the OAuth2 URL Generator
5. Update the controller configuration with your bot token and other Discord details

## SSL Configuration (Optional)

For secure WebSocket connections, generate SSL certificates:

```bash
mkdir -p controller/certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout controller/certs/key.pem -out controller/certs/cert.pem
```

Then update the controller configuration to use SSL:

```json
"websocket": {
    "port": 4000,
    "useSSL": true,
    "sslCertPath": "./certs/cert.pem",
    "sslKeyPath": "./certs/key.pem",
    ...
}
```

If you prefer not to use SSL, change the WebSocket configuration to:

```json
"websocket": {
    "port": 4000,
    "useSSL": false,
    ...
}
```

And make sure your agent configuration uses the non-SSL WebSocket URL:

```json
"controllerUrl": "ws://localhost:4000"
```

For SSL connections, agents should use secure WebSocket protocol:

```json
"controllerUrl": "wss://controller-host:4000"
```

> **Note**: Using SSL is highly recommended for production environments, especially if agents connect over public networks.

[← Back to main README](../README.md#-documentation) | [Next: Controller Documentation →](CONTROLLER.md)