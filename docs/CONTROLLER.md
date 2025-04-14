# Controller Documentation

[← Back to main README](../README.md#-documentation)

The Controller is the central component of the Automi system, responsible for managing all automation tasks, agents, and providing the Discord bot interface.

## Overview

The Controller performs several key functions:
- Manages the database containing tasks and agent information
- Runs the WebSocket server for agent communication
- Provides the Discord bot interface for user interaction
- Schedules and coordinates task execution
- Maintains system logs and monitors agent health

## Components

### Database Management

The Controller maintains a MySQL database with the following models:
- **Agents**: Information about registered automation agents
- **Tasks**: Automation task definitions
- **TaskRun**: Historical record of task executions
- **TaskDependency**: Relationships between dependent tasks
- **Assets**: Global key-value pairs accessible to all tasks

### WebSocket Server

The WebSocket server handles all communication with agents, including:
- Agent registration and authentication
- Task distribution to appropriate agents
- Result collection from completed tasks
- Agent status monitoring

### Discord Bot

The Discord bot provides a user-friendly interface to:
- Manage agents (add, edit, list, info)
- Configure tasks (add, edit, delete, list)
- Run tasks on demand
- Create task dependencies
- Monitor task execution status
- View logs from agents and tasks

### Task Scheduler

The task scheduler component:
- Manages recurring task execution
- Handles task dependencies and ensures correct execution order
- Monitors task execution and failure handling

## Configuration

The Controller is configured through the `config.json` file:

```json
{
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

## Starting the Controller

To start the Controller:

```bash
node index.js
```

## Logs and Monitoring

Logs are stored in the `logs/` directory:

```
logs/
  controller-YYYY-MM-DD.log
```

[← Back to main README](../README.md#-documentation) | [Next: Agent Documentation →](AGENTS.md)