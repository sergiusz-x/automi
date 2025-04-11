const WebSocket = require("ws")
const logger = require("../utils/logger")
const db = require("../db")
const agentState = require("./agentState")

// Active task executions
const activeTasks = new Map() // taskId -> { taskName, dbRunId }

/**
 * Validate WebSocket state
 * @param {WebSocket} socket - WebSocket connection to validate
 * @returns {boolean} True if socket is in OPEN state
 */
function isSocketValid(socket) {
    return socket && socket.readyState === 1 // WebSocket.OPEN
}

/**
 * Register agent connection
 * @param {string} agentId Agent ID
 * @param {WebSocket} wsConnection WebSocket connection
 */
function registerAgent(agentId, wsConnection) {
    logger.info(`🔌 Registering agent ${agentId}`)
    const agent = {
        agentId,
        wsConnection,
        tasks: new Map(),
        lastSeen: Date.now()
    }
    agentState.setAgent(agentId, agent)

    // Update agent status in database
    db.Agent.update({ status: "online", lastSeen: new Date() }, { where: { agentId } }).catch(err => {
        logger.error(`❌ Failed to update agent status in database:`, err)
    })

    // Notify task manager about agent connection
    // Removed direct taskManager dependency - will be handled by event system
    logger.info(`✅ Agent ${agentId} registered successfully`)
}

/**
 * Unregister an agent and close its connection
 * @param {string} agentId - Agent to unregister
 * @throws {Error} If agent ID is invalid
 */
function unregisterAgent(agentId) {
    if (!agentId) {
        throw new Error("Invalid agent ID")
    }

    const agent = agentState.getAgent(agentId)
    if (agent?.wsConnection && isSocketValid(agent.wsConnection)) {
        agent.wsConnection.close(4006, "Manually unregistered")
    }
    agentState.removeAgent(agentId)
    logger.info(`🧹 Agent ${agentId} unregistered`)
}

/**
 * Check if agent is online
 * @param {string} agentId Agent ID to check
 * @returns {boolean} True if agent is online
 */
function isAgentOnline(agentId) {
    return agentState.isAgentOnline(agentId)
}

/**
 * Get the WebSocket connection for an agent
 * @param {string} agentId - Agent to get socket for
 * @returns {WebSocket|null} Agent's socket or null if offline
 */
function getAgentSocket(agentId) {
    const agent = agentState.getAgent(agentId)
    return agent?.wsConnection && isSocketValid(agent.wsConnection) ? agent.wsConnection : null
}

/**
 * Get list of all connected agent IDs
 * @returns {string[]} Array of active agent IDs
 */
function listActiveAgents() {
    return agentState.listAgents()
}

/**
 * Send a message to a specific agent
 * @param {string} agentId - Target agent
 * @param {object} payload - Message to send
 * @returns {boolean} True if message was sent successfully
 * @throws {Error} If payload is invalid
 */
function sendToAgent(agentId, payload) {
    if (!payload || typeof payload !== "object") {
        throw new Error("Invalid payload")
    }

    const agent = agentState.getAgent(agentId)
    if (!agent?.wsConnection || !isSocketValid(agent.wsConnection)) {
        logger.warn(`❌ Cannot send to agent ${agentId} - Not connected`)
        return false
    }

    try {
        const message = JSON.stringify(payload)
        agent.wsConnection.send(message)
        logger.debug(`📤 Sent message to agent ${agentId}:`, payload.type)
        return true
    } catch (err) {
        logger.error(`❌ Failed to send message to ${agentId}:`, err)
        return false
    }
}

/**
 * Register task execution for tracking
 * @param {string} taskId - Task identifier
 * @param {Object} meta - Task metadata
 * @throws {Error} If task ID or metadata is invalid
 */
function registerTaskRun(taskId, meta) {
    if (!taskId || !meta || !meta.taskName || !meta.dbRunId) {
        throw new Error("Invalid task registration data")
    }

    activeTasks.set(taskId, meta)
    logger.debug(`📝 Registered task run: ${taskId} (${meta.taskName})`)
}

/**
 * Get metadata for an active task
 * @param {string} taskId - Task to look up
 * @returns {Object|null} Task metadata or null if not found
 */
function getTaskMeta(taskId) {
    return activeTasks.get(taskId) || null
}

/**
 * Remove task tracking data
 * @param {string} taskId - Task to clear
 */
function clearTaskMeta(taskId) {
    if (activeTasks.delete(taskId)) {
        logger.debug(`🧹 Cleared task metadata: ${taskId}`)
    }
}

/**
 * Disconnect all agents
 * Used during shutdown
 * @param {boolean} silentMode - If true, avoid database operations
 */
function disconnectAll(silentMode = false) {
    const agentCount = agentState.listAgents().length
    logger.info(`🔌 Disconnecting ${agentCount} agents...`)

    // Set global flag if in silent mode
    if (silentMode) {
        global.isShuttingDown = true
    }

    // Close all WebSocket connections
    for (const agentId of agentState.listAgents()) {
        const agent = agentState.getAgent(agentId)
        if (agent?.wsConnection && isSocketValid(agent.wsConnection)) {
            agent.wsConnection.close(1000, "Server shutting down")
        }
    }

    // Clear agent state
    for (const agentId of agentState.listAgents()) {
        agentState.removeAgent(agentId)
    }

    // Clear task tracking
    activeTasks.clear()

    logger.info("✅ All agents disconnected")
}

module.exports = {
    registerAgent,
    unregisterAgent,
    isAgentOnline,
    getAgentSocket,
    listActiveAgents,
    sendToAgent,
    registerTaskRun,
    getTaskMeta,
    clearTaskMeta,
    disconnectAll
}
