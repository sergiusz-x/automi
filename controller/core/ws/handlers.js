/**
 * WebSocket Connection Handler Module
 * Manages agent connections and message processing
 */
const logger = require("../../utils/logger")
const db = require("../../db")
const taskManager = require("../taskManager")
const { sendTaskResult } = require("../../services/webhook")
const agentState = require("../agentState")

// Rate limiting settings
const MESSAGE_RATE_LIMIT = 100 // messages per window
const RATE_LIMIT_WINDOW = 60000 // 1 minute in ms
const rateLimiters = new Map() // agentId -> {count, resetTime}

/**
 * Rate limiting check for message processing
 * @param {string} agentId - Agent identifier
 * @returns {boolean} True if rate limit exceeded
 */
function checkRateLimit(agentId) {
    const now = Date.now()
    const limiter = rateLimiters.get(agentId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW }

    if (now > limiter.resetTime) {
        limiter.count = 1
        limiter.resetTime = now + RATE_LIMIT_WINDOW
        rateLimiters.set(agentId, limiter)
        return false
    }

    limiter.count++
    if (limiter.count > MESSAGE_RATE_LIMIT) {
        logger.warn(`🚫 Rate limit exceeded for agent ${agentId}: ${limiter.count} messages in window`)
        return true
    }

    return false
}

/**
 * Validate agent authentication token
 * @param {Object} agent - Agent database record
 * @param {string} token - Provided authentication token
 * @returns {boolean} True if token is valid
 */
function validateAuthToken(agent, token) {
    if (!agent || !token) {
        return false
    }

    // Use timing-safe comparison to prevent timing attacks
    try {
        const crypto = require("crypto")
        return crypto.timingSafeEqual(Buffer.from(agent.token, "utf8"), Buffer.from(token, "utf8"))
    } catch (err) {
        logger.error(`❌ Token validation error:`, err)
        // If error occurs (e.g. different buffer lengths), return false
        return false
    }
}

/**
 * Validate IP address against whitelist
 * @param {Object} agent - Agent database record
 * @param {string} ip - Connection IP address
 * @returns {boolean} True if IP is allowed
 */
function validateIpAddress(agent, ip) {
    if (!agent || !ip) {
        logger.warn(`❌ Missing agent record or IP for validation`)
        return false
    }

    // Parse ipWhitelist if it's a string
    let whitelist
    try {
        whitelist = typeof agent.ipWhitelist === "string" ? JSON.parse(agent.ipWhitelist) : agent.ipWhitelist
    } catch (err) {
        logger.error(`❌ Failed to parse ipWhitelist for agent ${agent.agentId}:`, err)
        return false
    }

    // If list is empty or invalid, use strict mode (reject all)
    if (!Array.isArray(whitelist) || whitelist.length === 0) {
        logger.warn(`⚠️ Agent ${agent.agentId} has empty IP whitelist - rejecting connection`)
        return false
    }

    // If there's a wildcard (*), all IPs are allowed
    if (whitelist.includes("*")) {
        logger.info(`⚠️ Agent ${agent.agentId} allows all IPs (wildcard)`)
        return true
    }

    // Check for CIDR notation in whitelist (e.g. 192.168.1.0/24)
    for (const entry of whitelist) {
        if (entry.includes("/")) {
            if (isIpInCidrRange(ip, entry)) {
                return true
            }
            continue
        }

        // Direct IP match
        if (entry === ip) {
            return true
        }
    }

    logger.warn(`❌ IP ${ip} not in whitelist for agent ${agent.agentId}`)
    return false
}

/**
 * Check if IP is in CIDR range
 * @param {string} ip - IP address to check
 * @param {string} cidr - CIDR range (e.g. 192.168.1.0/24)
 * @returns {boolean} - True if IP is in range
 */
function isIpInCidrRange(ip, cidr) {
    try {
        const [range, bits] = cidr.split("/")
        const mask = parseInt(bits, 10)

        if (isNaN(mask) || mask < 0 || mask > 32) {
            return false
        }

        const ipInt = ipToInt(ip)
        const rangeInt = ipToInt(range)
        const maskInt = (0xffffffff << (32 - mask)) >>> 0

        return (ipInt & maskInt) === (rangeInt & maskInt)
    } catch (err) {
        logger.error(`❌ CIDR check error:`, err)
        return false
    }
}

/**
 * Convert IP address to integer
 * @param {string} ip - IP address
 * @returns {number} - Integer representation
 */
function ipToInt(ip) {
    return ip.split(".").reduce((int, octet) => (int << 8) + parseInt(octet, 10), 0) >>> 0
}

/**
 * Process task execution results
 * @param {string} agentId - Agent identifier
 * @param {Object} payload - Task execution results
 */
async function processTaskResult(agentId, payload) {
    try {
        // Find most recent running task run for this task
        const run = await db.TaskRun.findOne({
            where: {
                taskId: parseInt(payload.taskId, 10),
                status: "running"
            },
            order: [["createdAt", "DESC"]]
        })

        if (!run) {
            logger.error(`❓ No running task found for taskId ${payload.taskId}`)
            return
        }

        // Map agent status to run status
        const status = payload.status === "success" ? "success" : "error"

        // Calculate duration if not provided
        const durationMs = payload.durationMs || (run.startedAt ? Date.now() - run.startedAt.getTime() : 0)

        // Update run record in transaction with retry logic
        let retries = 3
        while (retries > 0) {
            try {
                await db.sequelize.transaction(
                    {
                        isolationLevel: db.Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED
                    },
                    async t => {
                        run.status = status
                        run.stdout = payload.stdout || ""
                        run.stderr = payload.stderr || ""
                        run.exitCode = payload.exitCode
                        run.durationMs = durationMs
                        run.finishedAt = new Date()
                        await run.save({ transaction: t })
                    }
                )

                // Notify task manager about completion outside of transaction
                await taskManager.handleTaskComplete(run.id, {
                    success: status === "success",
                    stdout: payload.stdout || "",
                    stderr: payload.stderr || "",
                    durationMs,
                    error: status === "error"
                })

                // Send webhook notification
                await sendTaskResult({
                    taskId: payload.taskId,
                    taskName: payload.name,
                    agentId: agentId,
                    status: status,
                    stdout: payload.stdout || "",
                    stderr: payload.stderr || "",
                    exitCode: payload.exitCode,
                    durationMs: durationMs
                })

                break // If successful, exit retry loop
            } catch (err) {
                retries--
                if (retries === 0) throw err
                // Wait before retry (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, (3 - retries) * 1000))
            }
        }
    } catch (err) {
        logger.error(`❌ Error processing task result:`, err)
        // Try to update run status to error if something went wrong
        try {
            run.status = "error"
            run.stderr = err.message
            await run.save()
        } catch (saveErr) {
            logger.error(`❌ Failed to save error status:`, saveErr)
        }
    }
}

/**
 * Handle new WebSocket connection from an agent
 * @param {WebSocket} socket - WebSocket connection
 * @param {http.IncomingMessage} req - HTTP request object
 */
function handleAgentConnection(socket, req) {
    const ip = req.socket.remoteAddress
    logger.info(`🔌 New WebSocket connection from ${ip}`)

    socket.on("open", () => {
        logger.info(`🔗 WebSocket connection established with ${socket.agentId || "unknown"}`)
    })

    let authenticated = false
    let agentId = null

    // Set connection timeout for authentication
    const authTimeout = setTimeout(() => {
        if (!authenticated) {
            logger.warn(`⏰ Authentication timeout for connection from ${ip}`)
            socket.close(4000, "Authentication timeout")
        }
    }, 5000)

    // Handle initial handshake message
    socket.once("message", async data => {
        try {
            const msg = JSON.parse(data)

            // Validate handshake message structure
            if (msg.type !== "init" || !msg.agentId || !msg.authToken) {
                logger.warn(`❌ Invalid handshake from ${ip}`)
                return socket.close(4001, "Invalid handshake")
            }

            agentId = msg.agentId
            const authToken = msg.authToken

            // Find agent record
            let agent = await db.Agent.findOne({ where: { agentId } })

            if (!agent) {
                logger.warn(`❌ Unknown agent: ${agentId}`)
                return socket.close(4004, "Unknown agent")
            }

            // Validate authentication
            if (!validateAuthToken(agent, authToken)) {
                logger.warn(`❌ Invalid token for agent ${agentId}`)
                return socket.close(4002, "Unauthorized")
            }

            // Validate IP whitelist
            if (!validateIpAddress(agent, ip)) {
                logger.warn(`❌ Connection from ${ip} rejected - IP not in whitelist for agent ${agentId}`)
                return socket.close(4003, "IP not in whitelist")
            }

            await agent.update({
                lastSeen: new Date(),
                status: "online"
            })

            // Complete authentication
            authenticated = true
            clearTimeout(authTimeout)

            // Register agent in agentState
            agentState.setAgent(agentId, {
                agentId,
                wsConnection: socket,
                lastSeen: Date.now()
            })

            // Notify task manager about connection
            taskManager.handleAgentConnect(agentId, socket)
            logger.info(`✅ Agent ${agentId} connected and authorized`)

            // Handle ongoing messages
            socket.on("message", async raw => {
                try {
                    // Rate limit check
                    if (checkRateLimit(agentId)) {
                        return
                    }

                    const message = JSON.parse(raw)

                    if (message.type === "result" && message.payload) {
                        await processTaskResult(agentId, message.payload)
                        return
                    }

                    if (message.type === "agent_error" && message.payload) {
                        logger.error(`❌ Agent ${agentId} reported error: ${message.payload.error} (at ${message.payload.timestamp})`)
                        return
                    }

                    logger.debug(`📩 Unhandled message from ${agentId}:`, message)
                } catch (err) {
                    logger.warn(`❌ Invalid message from agent ${agentId}:`, err.message)
                }
            })

            // Handle connection close
            socket.on("close", async () => {
                logger.info(`❌ Agent ${agentId} disconnected`)
                agentState.removeAgent(agentId)
                rateLimiters.delete(agentId)

                // Skip database operations if system is shutting down
                if (global.isShuttingDown) {
                    logger.debug(`Skipping database update for agent ${agentId} - system is shutting down`)
                    return
                }

                try {
                    await db.Agent.update({ status: "offline" }, { where: { agentId } })
                    // Notify task manager about disconnection
                    taskManager.handleAgentDisconnect(agentId)
                } catch (err) {
                    logger.error(`❌ Failed to update agent status for ${agentId}:`, err.message || "Unknown error")
                    logger.debug(`Error details: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`)
                }
            })
        } catch (err) {
            logger.error(`❌ Error processing handshake:`, err)
            socket.close(4000, "Invalid message format")
        }
    })
}

module.exports = handleAgentConnection
