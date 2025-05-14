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

// Add heartbeat interval tracking and default ping interval
let heartbeatInterval, pongTimeout
const PING_INTERVAL = config.pingInterval || 30000
const PONG_TIMEOUT = config.pongTimeout || 10000 // time to wait for pong

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

    socket = new WebSocket(config.controllerUrl, {
        headers: {
            "User-Agent": "Automi-Agent/1.0"
        }
    })
    logger.setSocket(socket)

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

        // Start heartbeat ping to detect silent disconnects
        logger.debug(`💓 Starting heartbeat ping every ${PING_INTERVAL}ms`)
        heartbeatInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
                logger.debug("💓 Sending ping to controller")
                socket.ping()
                // Schedule pong timeout
                if (pongTimeout) clearTimeout(pongTimeout)
                pongTimeout = setTimeout(() => {
                    logger.warn(
                        `❌ No pong received within ${PONG_TIMEOUT}ms, terminating connection to trigger reconnect`
                    )
                    socket.terminate()
                }, PONG_TIMEOUT)
            }
        }, PING_INTERVAL)
    })

    // Log incoming pongs and clear pong timeout
    socket.on("pong", () => {
        logger.debug("💓 Received pong from controller")
        if (pongTimeout) {
            clearTimeout(pongTimeout)
            pongTimeout = null
        }
    })
    socket.on("ping", () => {
        logger.debug("💓 Received ping from controller")
        socket.pong()
    })

    // Handle incoming messages
    socket.on("message", async data => {
        try {
            // Add validation for the message data before parsing
            if (!data || data.length === 0) {
                logger.warn("⚠️ Received empty message from controller, ignoring")
                return
            }

            const message = JSON.parse(data)

            // Validate message structure
            if (!message || !message.type) {
                logger.warn(
                    "⚠️ Received invalid message format from controller:",
                    typeof message === "object" ? JSON.stringify(message) : message
                )
                return
            }

            switch (message.type) {
                case "EXECUTE_TASK": {
                    // Validate required task properties
                    const { taskId, runId, name, type, script, params, assets } = message.payload || {}

                    if (!taskId || !name || !type || script === undefined) {
                        logger.error(
                            `❌ Invalid task data received: missing required properties`,
                            JSON.stringify(message.payload)
                        )
                        return
                    }

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

                        const startTime = Date.now()
                        logger.debug(`⏱️ Task ${name} starting at: ${new Date(startTime).toISOString()}`)

                        // Pass both params and assets to the runner
                        // The runner now returns an object with resultPromise and kill method
                        const runnerObj = await runner.run(script, params, assets || {})

                        // Store running task info - BEFORE awaiting the result
                        // Ensure taskId is stored as string for consistency
                        const taskIdStr = taskId.toString()
                        logger.debug(`📝 Storing task in runningTasks map with ID: ${taskIdStr}`)
                        runningTasks.set(taskIdStr, {
                            process: runnerObj, // Store the runner object with kill method
                            task: message.payload,
                            startTime
                        })

                        // Handle process result - wait for the promise to resolve
                        const result = await runnerObj.resultPromise
                        const endTime = Date.now()
                        const duration = endTime - startTime

                        logger.info(
                            `✅ Script execution completed with status: ${
                                result.success ? "success" : "error"
                            }, duration: ${duration}ms`
                        )

                        // Clear task tracking
                        runningTasks.delete(taskIdStr)
                        clearTaskMeta(taskIdStr)

                        // Send result back to controller
                        sendTaskResult(message.payload, {
                            ...result,
                            duration: duration
                        })
                    } catch (err) {
                        logger.error(`❌ Error executing task ${name}:`, err)
                        sendTaskResult(message.payload, {
                            success: false,
                            code: 1,
                            stdout: "",
                            stderr: err.message,
                            duration: 0
                        })
                        clearTaskMeta(taskId)
                    }
                    break
                }

                case "CANCEL_TASK": {
                    // Validate required properties
                    const { taskId } = message.payload || {}
                    if (!taskId) {
                        logger.warn("⚠️ Invalid CANCEL_TASK message: missing taskId")
                        return
                    }

                    logger.info(`🛑 Processing CANCEL_TASK message for task ${taskId}`)

                    // Convert taskId to string for consistent lookup
                    const taskIdStr = taskId.toString()

                    // Debug log current running tasks
                    logger.debug(`🔍 Current running tasks: [${Array.from(runningTasks.keys()).join(", ")}]`)

                    // Look up in runningTasks map first
                    const running = runningTasks.get(taskIdStr)

                    if (running && running.process) {
                        logger.info(`🛑 Killing process for task ${taskIdStr} (found in runningTasks map)`)
                        try {
                            // Call the kill() method on the process object
                            await running.process.kill()
                            logger.info(`✅ Task ${taskIdStr} successfully killed`)

                            // Remove task from the running tasks map
                            runningTasks.delete(taskIdStr)
                            clearTaskMeta(taskIdStr)

                            // Send notification about task cancellation
                            sendTaskResult(running.task, {
                                success: false,
                                code: 143,
                                stdout: "",
                                stderr: "Task cancelled by user",
                                duration: Date.now() - running.startTime
                            })
                        } catch (killErr) {
                            logger.error(`❌ Error killing task ${taskIdStr}:`, killErr)
                            // Still try to clean up even if kill failed
                            runningTasks.delete(taskIdStr)
                            clearTaskMeta(taskIdStr)
                        }
                    } else {
                        logger.warn(`⚠️ Task ${taskIdStr} not found in runningTasks map or has no process handler`)
                    }
                    break
                }

                default:
                    logger.warn(`⚠️ Unknown message type: ${message.type}`)
                    break
            }
        } catch (err) {
            logger.error("❌ Error processing message:", err)
            // Send error notification to controller
            try {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(
                        JSON.stringify({
                            type: "agent_error",
                            payload: {
                                error: err.toString(),
                                timestamp: new Date().toISOString()
                            }
                        })
                    )
                }
            } catch (sendErr) {
                logger.error("❌ Failed to send error notification:", sendErr)
            }
        }
    })

    // Handle connection close with reason and clear heartbeat
    socket.on("close", (code, reason) => {
        logger.warn(`❌ Connection closed with code ${code}, reason: ${reason.toString()}`)
        if (heartbeatInterval) clearInterval(heartbeatInterval)
        if (pongTimeout) clearTimeout(pongTimeout)

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

        logger.info(`🔄 Reconnecting in ${delay / 1000} seconds...`)
        setTimeout(connect, delay)
    })

    // Handle connection errors with stack trace and force reconnection
    socket.on("error", err => {
        logger.error(`❌ WebSocket error: ${err.stack || err}`)
        // Terminate socket on error to trigger reconnect
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            socket.terminate()
        }
    })
}

// Catch unhandled promise rejections and uncaught exceptions to prevent crash and trigger reconnect
process.on('unhandledRejection', (reason, promise) => {
    logger.error('❌ Unhandled promise rejection:', reason)
    if (socket && socket.readyState === WebSocket.OPEN) socket.terminate()
})
process.on('uncaughtException', err => {
    logger.error('❌ Uncaught exception:', err)
    if (socket && socket.readyState === WebSocket.OPEN) socket.terminate()
})

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
                runId: task.runId,
                name: task.name,
                status: result.success ? "success" : "error",
                exitCode: result.code,
                stdout: result.stdout || "",
                stderr: result.stderr || "",
                durationMs: result.duration || 0
            }
        }

        socket.send(JSON.stringify(message))
        logger.debug(`📤 Sent result for task ${task.name}:`, result.success ? "success" : "error")

        // Log duration for debugging
        if (result.duration) {
            logger.debug(`⏱️ Task ${task.name} duration: ${result.duration}ms (${Math.round(result.duration / 1000)}s)`)
        }
    } catch (err) {
        logger.error(`❌ Failed to send task result:`, err)
    }
}

/**
 * Handles agent shutdown process
 * @param {string} signal - The signal that triggered the shutdown (SIGTERM, SIGINT, etc.)
 */
function handleShutdown(signal) {
    logger.info(`🛑 Received ${signal} - shutting down...`)

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
}

// Handle process termination
process.on("SIGTERM", () => handleShutdown("SIGTERM"))
process.on("SIGINT", () => handleShutdown("SIGINT"))

// Start connection
connect()
