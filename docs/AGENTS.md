# Agents Documentation

[← Back to main README](../README.md)

Agents are distributed task executors in the Automi system, responsible for running automation scripts on their host machines.

## Overview

Agents connect to the central Controller via WebSocket and execute tasks using different runners:
- Bash script execution
- Python script execution
- Node.js script execution

## Agent Architecture

Agent consists of:
- **WebSocket Client**: For communication with the Controller
- **Task Runners**: Components that execute specific types of scripts
- **Logger**: For local and remote logging
- **Task Manager**: For managing task execution and reporting results

## Installation

For installation instructions, refer to the [Installation Guide](./INSTALLATION.md).

## Configuration

Agents are configured using the `config.json` file:

```json
{
    "agentId": "agent-id-here",
    "token": "your-secure-token-here",
    "controllerUrl": "ws://localhost:4000"
}
```

Where:
- `agentId`: A unique identifier for this agent (must match the ID registered in the Controller)
- `token`: A secure token for authentication
- `controllerUrl`: The WebSocket URL of the Controller

## Task Execution

Agents can execute three types of scripts:

### Bash Scripts

Executes shell scripts on the agent's host machine:

```bash
# Example Bash task
#!/bin/bash
echo "Running backup process..."
tar -czf /backup/files_$(date +%Y%m%d).tar.gz /data
echo "Backup completed!"
```

### Python Scripts

Executes Python code on the agent's host machine:

```python
# Example Python task
import os
import shutil

def backup_files():
    source_dir = "/data"
    dest_dir = f"/backup/files_{datetime.now().strftime('%Y%m%d')}"
    shutil.copytree(source_dir, dest_dir)
    print("Python backup completed!")

if __name__ == "__main__":
    backup_files()
```

### Node.js Scripts

Executes Node.js code on the agent's host machine:

```javascript
// Example Node.js task
const fs = require('fs')
const path = require('path')

function backupFiles() {
    const sourceDir = '/data'
    const destDir = `/backup/files_${new Date().toISOString().split('T')[0]}`
    
    fs.cpSync(sourceDir, destDir, { recursive: true })
    console.log('Node.js backup completed!')
}

backupFiles()
```

## Task Parameters

Tasks can receive dynamic parameters that modify their behavior without changing the underlying script. This allows for flexible task execution with varying inputs.

### Parameter Handling

Parameters are passed to tasks as a JSON object and can be accessed within scripts:

#### In Bash scripts:
```bash
echo "Example param: $PARAM_EXAMPLE"
```

#### In Python scripts:
```python
example = os.environ['PARAM_EXAMPLE']
```

#### In Node.js scripts:
```javascript
const example = process.env.PARAM_EXAMPLE
```

### Providing Parameters Manually

When running tasks manually via Discord, you can specify parameters using the `params` option with a JSON object:

```
/task run name:example_task params:{"example":"Lorem Ipsum"}
```

## Logs

Agent logs are stored in the `logs/` directory:

```
logs/
  agent-YYYY-MM-DD.log
```

## Security

Agent security is managed through:
- Token-based authentication with the Controller
- Encrypted WebSocket communication (when SSL is enabled)
- Rate limiting to prevent abuse
- Safe script execution practices

## Error Handling

Agents implement robust error handling:
- Automatic reconnection with exponential backoff
- Task failure reporting
- Process isolation for script execution

## Process Management

Agents can:
- Execute multiple tasks simultaneously
- Kill running tasks on request
- Detect and report if a task exceeds time limits
- Clean up after task completion or failure

[← Back to main README](../README.md)