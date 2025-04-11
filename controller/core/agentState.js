const WebSocket = require("ws")
const logger = require("../utils/logger")

// Active agent connections
const agents = new Map() // agentId -> {agentId, wsConnection, tasks, lastSeen}

/**
 * Check if agent is online
 * @param {string} agentId Agent ID to check
 * @returns {boolean} True if agent is online
 */
function isAgentOnline(agentId) {
    const agent = agents.get(agentId)
    if (!agent) {
        logger.debug(`Agent ${agentId} not found in active agents map`)
        return false
    }

    const wsConnection = agent.wsConnection
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
        logger.debug(`Agent ${agentId} WebSocket connection not open (state: ${wsConnection?.readyState})`)
        return false
    }

    return true
}

/**
 * Get agent state
 * @param {string} agentId Agent ID
 * @returns {Object|undefined} Agent state object or undefined if not found
 */
function getAgent(agentId) {
    return agents.get(agentId)
}

/**
 * Set agent state
 * @param {string} agentId Agent ID
 * @param {Object} state Agent state object
 */
function setAgent(agentId, state) {
    agents.set(agentId, state)
}

/**
 * Remove agent state
 * @param {string} agentId Agent ID
 */
function removeAgent(agentId) {
    agents.delete(agentId)
}

/**
 * List all active agents
 * @returns {string[]} Array of agent IDs
 */
function listAgents() {
    return Array.from(agents.keys())
}

module.exports = {
    isAgentOnline,
    getAgent,
    setAgent,
    removeAgent,
    listAgents
}
