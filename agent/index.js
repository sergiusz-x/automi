/**
 * Automi Agent Main Application
 * Handles communication with the controller and executes tasks
 */
const WebSocket = require("ws")
const logger = require("./utils/logger")
const config = require("./config.json")

// Load task runners for supported script types
const runners = {
    bash: require("./runner/bash"),
    python: require("./runner/python"),
    node: require("./runner/node")
}

let socket
let reconnectAttempt = 0
const MAX_RECONNECT_DELAY = 30000 // Maximum reconnect delay of 30 seconds

// Track running tasks and metadata
const runningTasks = new Map()
const taskMeta = new Map()

/**
 * Register task execution metadata
 * @param {string} taskId Task identifier
 * @param {Object} meta Task metadata
 */
function registerTaskRun(taskId, meta) {
    if (!taskId || !meta || !meta.taskName) {
        throw new Error("Invalid task registration data")
    }
    logger.debug(`📝 Registering task run: ${taskId} (${meta.taskName})`)
    taskMeta.set(taskId, meta)
}

/**
 * Clear task metadata
 * @param {string} taskId Task to clear
 */
function clearTaskMeta(taskId) {
    if (taskMeta.delete(taskId)) {
        logger.debug(`🧹 Cleared task metadata: ${taskId}`)
    }
}

/**
 * Creates and manages WebSocket connection to controller
 * Handles authentication, message processing, and reconnection
 */
function connect() {
    logger.info(`🔌 Connecting to controller at ${config.controllerUrl}...`)

    socket = new WebSocket(config.controllerUrl)

    // Connection established successfully
    socket.on("open", () => {
        reconnectAttempt = 0 // Reset reconnect counter on successful connection
        logger.info("✅ Connected to controller. Sending handshake...")
        
        // Send authentication data
        socket.send(
            JSON.stringify({
                type: "init",
                agentId: config.agentId,
                authToken: config.token
            })
        )
    })

    // Handle incoming messages
    socket.on("message", async (data) => {
        try {
            const message = JSON.parse(data)

            switch (message.type) {
                case "EXECUTE_TASK": {
                    const { taskId, runId, name, type, script, params } = message.payload

                    // Register task run
                    registerTaskRun(taskId, {
                        taskName: name,
                        dbRunId: runId
                    })

                    try {
                        const runner = runners[type]
                        if (!runner) {
                            throw new Error(`Unsupported script type: ${type}`)
                        }

                        const process = await runner.run(script, params)
                        const startTime = Date.now()

                        // Store running task info
                        runningTasks.set(taskId, {
                            process,
                            task: message.payload,
                            startTime
                        })

                        // Handle process result
                        const result = await process
                        logger.info(`✅ Script execution completed with status: ${result.success ? 'success' : 'error'}`)

                        // Clear task tracking
                        runningTasks.delete(taskId)
                        clearTaskMeta(taskId)

                        // Send result back to controller
                        sendTaskResult(message.payload, {
                            ...result,
                            duration: Date.now() - startTime
                        })

                    } catch (err) {
                        logger.error(`❌ Error executing task ${name}:`, err)
                        sendTaskResult(message.payload, {
                            success: false,
                            code: 1,
                            stdout: "",
                            stderr: err.message
                        })
                        clearTaskMeta(taskId)
                    }
                    break
                }

                case "CANCEL_TASK": {
                    const { taskId } = message.payload
                    logger.info(`🛑 Processing CANCEL_TASK message for task ${taskId}`)

                    const running = runningTasks.get(taskId)
                    if (running?.process) {
                        logger.info(`🛑 Killing process for task ${taskId}`)
                        running.process.kill()
                        runningTasks.delete(taskId)
                        clearTaskMeta(taskId)

                        sendTaskResult(running.task, {
                            success: false,
                            code: 143,
                            stdout: "",
                            stderr: "Task cancelled by user",
                            duration: Date.now() - running.startTime
                        })
                    }
                    break
                }
            }

        } catch (err) {
            logger.error("❌ Error processing message:", err)
        }
    })

    // Handle connection close
    socket.on("close", code => {
        logger.warn(`❌ Connection closed with code ${code}`)

        // Kill any running tasks
        for (const [taskId, { process, task, startTime }] of runningTasks.entries()) {
            try {
                process.kill()
                sendTaskResult(task, {
                    success: false,
                    code: 143,
                    stdout: "",
                    stderr: "Task cancelled due to connection loss",
                    duration: Date.now() - startTime
                })
            } catch (err) {
                logger.error(`❌ Error killing task ${taskId}:`, err)
            }
        }
        runningTasks.clear()

        // Schedule reconnection attempt
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY)
        reconnectAttempt++

        logger.info(`🔄 Reconnecting in ${delay/1000} seconds...`)
        setTimeout(connect, delay)
    })

    // Handle connection errors
    socket.on("error", err => {
        logger.error(`❌ WebSocket error:`, err)
    })
}

/**
 * Send task execution results back to controller
 * @param {Object} task - Original task definition
 * @param {Object} result - Task execution results
 */
function sendTaskResult(task, result) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        logger.error(`❌ Cannot send result for task ${task.name} - Not connected`)
        return
    }

    try {
        const message = {
            type: "result",
            payload: {
                taskId: task.taskId,
                name: task.name,
                status: result.success ? "success" : "error",
                exitCode: result.code,
                stdout: result.stdout || "",
                stderr: result.stderr || "",
                durationMs: result.duration
            }
        }

        socket.send(JSON.stringify(message))
        logger.debug(`📤 Sent result for task ${task.name}:`, result.success ? "success" : "error")
    } catch (err) {
        logger.error(`❌ Failed to send task result:`, err)
    }
}

// Handle process termination
process.on("SIGTERM", () => {
    logger.info("🛑 Received SIGTERM - shutting down...")
    
    // Kill any running tasks
    for (const [taskId, { process, task, startTime }] of runningTasks.entries()) {
        try {
            process.kill()
            sendTaskResult(task, {
                success: false,
                code: 143,
                stdout: "",
                stderr: "Task cancelled due to agent shutdown",
                duration: Date.now() - startTime
            })
        } catch (err) {
            logger.error(`❌ Error killing task ${taskId}:`, err)
        }
    }
    runningTasks.clear()

    if (socket) {
        socket.close(1000, "Agent shutting down")
    }
    process.exit(0)
})

process.on("SIGINT", () => {
    logger.info("🛑 Received SIGINT - shutting down...")
    
    // Kill any running tasks
    for (const [taskId, { process, task, startTime }] of runningTasks.entries()) {
        try {
            process.kill()
            sendTaskResult(task, {
                success: false,
                code: 143,
                stdout: "",
                stderr: "Task cancelled due to agent shutdown",
                duration: Date.now() - startTime
            })
        } catch (err) {
            logger.error(`❌ Error killing task ${taskId}:`, err)
        }
    }
    runningTasks.clear()

    if (socket) {
        socket.close(1000, "Agent shutting down")
    }
    process.exit(0)
})

// Start connection
connect()
