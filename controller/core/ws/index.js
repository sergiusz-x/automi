/**
 * WebSocket Server Module
 * Provides real-time communication with agents
 */
const WebSocket = require("ws")
const https = require("https")
const http = require("http")
const fs = require("fs")
const config = require("../../utils/config")
const logger = require("../../utils/logger")
const handleAgentConnection = require("./handlers")

let wss
let heartbeatInterval

/**
 * Initialize and start the WebSocket server
 * Supports both secure (WSS) and non-secure (WS) connections
 */
async function startWebSocketServer() {
    const port = config.websocket.port || 4000
    let server

    // Configure SSL if enabled
    if (config.websocket.useSSL) {
        logger.info("🔒 Initializing secure WebSocket server (WSS)...")
        try {
            const sslOptions = {
                cert: fs.readFileSync(config.websocket.sslCertPath),
                key: fs.readFileSync(config.websocket.sslKeyPath)
            }
            server = https.createServer(sslOptions)
            logger.info("✅ SSL configuration loaded successfully")
        } catch (err) {
            logger.error("❌ Failed to load SSL certificates:", err)
            throw err
        }
    } else {
        logger.info("🔓 Initializing non-secure WebSocket server (WS)...")
        server = http.createServer()
    }

    // Create WebSocket server with connection validation
    wss = new WebSocket.Server({ 
        server,
        verifyClient: validateConnection
    })

    // Set up server event handlers
    setupServerHandlers()

    // Start listening for connections
    server.listen(port, () => {
        logger.info(
            `🌐 WebSocket server running on ${config.websocket.useSSL ? "wss" : "ws"}://localhost:${port}`
        )
    })

    // Set up periodic connection monitoring
    setupHeartbeat()

    // Handle server errors
    server.on("error", (err) => {
        logger.error("❌ Server error:", err)
    })

    return wss
}

/**
 * Validate incoming connections
 * @param {Object} info Connection information
 * @param {Function} callback Validation callback
 */
function validateConnection(info, callback) {
    const ip = info.req.socket.remoteAddress
    logger.debug(`🔍 New connection attempt from ${ip}`)

    // Add any additional connection validation here
    // For example, rate limiting or IP blacklist checking

    callback(true) // Accept the connection
}

/**
 * Set up WebSocket server event handlers
 */
function setupServerHandlers() {
    wss.on("connection", (socket, req) => {
        // Initialize socket state
        socket.isAlive = true
        socket.remoteAddress = req.socket.remoteAddress

        // Set up ping-pong heartbeat
        socket.on("pong", () => {
            socket.isAlive = true
            logger.debug(`💓 Heartbeat from ${socket.agentId || "unknown"}`)
        })

        // Handle connection errors
        socket.on("error", (err) => {
            logger.error(`❌ Socket error from ${socket.agentId || "unknown"}:`, err)
        })

        // Pass socket to connection handler
        handleAgentConnection(socket, req)
    })

    wss.on("error", (err) => {
        logger.error("❌ WebSocket server error:", err)
    })
}

/**
 * Set up periodic heartbeat checking
 * Monitors connection health and removes dead connections
 */
function setupHeartbeat() {
    const HEARTBEAT_INTERVAL = 30000 // 30 seconds

    heartbeatInterval = setInterval(() => {
        wss.clients.forEach((socket) => {
            if (!socket.isAlive) {
                logger.warn(`💔 Terminating dead connection: ${socket.agentId || "unknown"}`)
                return socket.terminate()
            }

            socket.isAlive = false
            socket.ping(() => {})
        })
    }, HEARTBEAT_INTERVAL)

    // Clean up interval on server close
    wss.on("close", () => {
        clearInterval(heartbeatInterval)
    })
}

/**
 * Gracefully shut down the WebSocket server
 */
async function shutdown() {
    logger.info("🛑 Shutting down WebSocket server...")
    
    // Clear heartbeat interval
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
    }

    // Close all client connections
    wss.clients.forEach((client) => {
        client.close(1000, "Server shutting down")
    })

    // Close the server
    return new Promise((resolve) => {
        wss.close(() => {
            logger.info("✅ WebSocket server shut down successfully")
            resolve()
        })
    })
}

module.exports = startWebSocketServer
module.exports.shutdown = shutdown
