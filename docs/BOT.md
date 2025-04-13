# Discord Bot Documentation

[← Back to main README](../README.md)

The Discord bot provides a user-friendly interface to interact with the Automi system, allowing you to manage agents, tasks, and view logs directly from Discord.

## Overview

The Discord bot enables:
- Managing agents and tasks
- Running tasks on-demand
- Viewing real-time task status
- Accessing logs from agents and tasks
- Setting up automated status messages

## Commands Reference

Below is a comprehensive list of all available Discord bot commands:

### Agent Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/agent add` | Registers a new agent in the system | `/agent add id:<agent_id> [ip:<allowed_ip>]` |
| `/agent edit` | Edits agent's IP whitelist | `/agent edit id:<agent_id>` |
| `/agent info` | Shows detailed information about a specific agent | `/agent info id:<agent_id>` |
| `/agent list` | Lists all registered agents with their status | `/agent list` |

### Task Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/task add` | Creates a new automation task | `/task add name:<task_name> type:<bash/python/node> agent:<agent_id> [script_file:<file>] [schedule:<cron>] [params:<json>]` |
| `/task delete` | Removes a task from the system | `/task delete name:<task_name>` |
| `/task edit` | Modifies an existing task | `/task edit name:<task_name>` |
| `/task link` | Creates a dependency between two tasks | `/task link parent:<task_name> child:<task_name> [condition:<always/on_success/on_error>]` |
| `/task list` | Lists all registered tasks | `/task list [agent:<agent_id>]` |
| `/task run` | Executes a task immediately | `/task run name:<task_name> [params:<json>]` |
| `/task status` | Shows the current status of a running task | `/task status name:<task_name>` |
| `/task unlink` | Removes a dependency between tasks | `/task unlink parent:<task_name> child:<task_name>` |

### Log Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/log agent` | Shows execution logs from a specific agent | `/log agent id:<agent_id> [status:<all/success/error>] [time:<all/1h/24h/7d/30d>]` |
| `/log recent` | Shows recent log entries from the controller | `/log recent [status:<all/success/error>] [time:<1h/24h/7d>] [agent:<agent_id>] [task:<task_name>]` |
| `/log task` | Shows log entries from a specific task run | `/log task name:<task_name> [status:<all/success/error>] [limit:<number>]` |

### Config Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `/config status` | Creates and saves a live status embed in the current channel | `/config status` |

## Status Messages

The bot maintains a status message in a designated channel that provides real-time information including:

- **System Status Overview**: Current operational status of the controller
- **Agent Information**: Count of all agents
- **Active Tasks**: Currently running tasks with progress information
- **Recent Task Runs**: The most recent task executions with status and completion time
- **Recent Errors**: Any errors that have occurred in the system recently

The status message is automatically updated every half minute

## Bot Status Display

The Discord bot itself displays its status with custom status messages that indicate number of runs and % of success rate in last 24h


## Interactive Controls

The bot provides rich interactive elements across various commands:

- **Task Management**:
  - Confirmation buttons when deleting tasks
  - Script editor modals for creating and editing tasks
  - File upload options for script files

- **Log Viewing**:
  - Pagination buttons for browsing through multiple pages of logs
  - Filter dropdown menus for status (success/error)
  - Time range selectors (1h, 24h, 7d, 30d)
  - Truncated output with indicators for large logs

- **Agent Management**:
  - IP whitelist editor modals
  - Agent selection autocomplete

## Webhook Integration

The controller configuration includes a `webhookUrl` setting that sends notifications about:

- **Task Execution Results**: Success and failure notifications for task runs
- **Error Reporting**: Daily summary reports of agent errors if any occur

```json
"discord": {
    "webhookUrl": "YOUR_DISCORD_WEBHOOK_URL"
}
```

[← Back to main README](../README.md)