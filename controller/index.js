/**
 * Automi Controller Main Application
 * Initializes and manages all controller components:
 * - Database connection and model synchronization
 * - WebSocket server for agent communication
 * - Discord bot for user interaction
 * - Task scheduler for automated execution
 */
const logger = require("./utils/logger")
const startWebSocketServer = require("./core/ws")
const startDiscordBot = require("./bot")
const startScheduler = require("./core/scheduler")
const db = require("./db")

/**
 * Initialize all controller components
 * Handles startup in the correct order and proper error handling
 */
async function startController() {
    logger.info("🚀 Starting Automi Controller...")

    try {
        // Initialize database connection with retries
        logger.info("📊 Connecting to database...")
        const dbConnected = await db.connect(5, 5000) // 5 retries, starting with 5 second delay

        if (!dbConnected) {
            throw new Error("Failed to connect to database after multiple attempts")
        }

        logger.info("✅ Database connection established")

        // Synchronize database models with retry logic
        try {
            logger.info("🔄 Synchronizing database models...")
            let syncRetries = 3
            let syncError = null

            while (syncRetries > 0) {
                try {
                    await db.sequelize.sync({ alter: true })
                    logger.info("✅ Database tables synchronized")
                    syncError = null
                    break
                } catch (err) {
                    syncRetries--
                    syncError = err

                    if (syncRetries === 0) {
                        throw err
                    }

                    logger.warn(`⚠️ Database sync failed, retrying... (${syncRetries} attempts left): ${err.message}`)
                    await new Promise(resolve => setTimeout(resolve, 3000))
                }
            }

            if (syncError) {
                throw syncError
            }
        } catch (syncErr) {
            logger.error("❌ Failed to synchronize database models:", syncErr)
            throw syncErr
        }

        // Initialize task manager
        logger.info("🔄 Initializing task manager...")
        try {
            const taskManager = require("./core/taskManager")
            await taskManager.initialize()
            logger.info("✅ Task manager initialized")
        } catch (taskErr) {
            logger.error("❌ Failed to initialize task manager:", taskErr)
            throw taskErr
        }

        // Start WebSocket server for agent connections
        logger.info("🌐 Initializing WebSocket server...")
        try {
            await startWebSocketServer()
            logger.info("✅ WebSocket server started")
        } catch (wsErr) {
            logger.error("❌ Failed to start WebSocket server:", wsErr)
            throw wsErr
        }

        // Initialize Discord bot
        logger.info("🤖 Starting Discord bot...")
        try {
            await startDiscordBot()
            logger.info("✅ Discord bot initialized")
        } catch (botErr) {
            logger.error("❌ Failed to initialize Discord bot:", botErr)
            // Non-fatal error, continue startup
            logger.warn("⚠️ Continuing without Discord bot")
        }

        // Start task scheduler
        logger.info("⏰ Initializing task scheduler...")
        try {
            await startScheduler()
            logger.info("✅ Task scheduler started")
        } catch (schedErr) {
            logger.error("❌ Failed to start task scheduler:", schedErr)
            throw schedErr
        }

        logger.info("🎉 Automi Controller is up and running")

        // Handle graceful shutdown
        process.on("SIGTERM", gracefulShutdown)
        process.on("SIGINT", gracefulShutdown)
    } catch (err) {
        logger.error("❌ Failed to start Controller:", err)
        process.exit(1)
    }
}

/**
 * Gracefully shut down all components
 */
async function gracefulShutdown(signal = "SIGTERM") {
    logger.info(`🛑 Shutting down Automi Controller (signal: ${signal})...`)

    try {
        // 1. Set the global shutdown flag to prevent DB operations during shutdown
        global.isShuttingDown = true

        // 2. Stop task scheduler
        logger.info("⏰ Stopping task scheduler...")
        try {
            startScheduler.stopAllJobs()
            logger.info("✅ Task scheduler stopped")
        } catch (schedErr) {
            logger.error("❌ Error stopping task scheduler:", schedErr)
            // Continue shutdown despite errors
        }

        // 3. Update all agent statuses in database to offline in one batch operation
        logger.info("📊 Updating agent statuses in database...")
        try {
            const allAgents = await db.Agent.findAll({ where: { status: "online" } })
            if (allAgents.length > 0) {
                await db.Agent.update({ status: "offline" }, { where: { status: "online" } })
                logger.info(`✅ Updated ${allAgents.length} agents to offline status in database`)
            }
        } catch (dbErr) {
            logger.error("❌ Failed to update agent statuses:", dbErr.message)
            // Continue shutdown despite errors
        }

        // 4. Disconnect agents - notify them but don't update DB
        logger.info("🔌 Disconnecting agents...")
        try {
            const agents = require("./core/agents")
            agents.disconnectAll(true) // true = silent mode, avoid DB updates
            logger.info("✅ Agents notified about disconnection")
        } catch (agentErr) {
            logger.error("❌ Error disconnecting agents:", agentErr)
            // Continue shutdown despite errors
        }

        // 5. Close WebSocket server
        logger.info("🌐 Stopping WebSocket server...")
        try {
            await require("./core/ws").shutdown()
            logger.info("✅ WebSocket server stopped")
        } catch (wsErr) {
            logger.error("❌ Error stopping WebSocket server:", wsErr)
            // Continue shutdown despite errors
        }

        // 6. Close database connection
        logger.info("📊 Closing database connection...")
        try {
            await db.sequelize.close()
            logger.info("✅ Database connection closed")
        } catch (dbErr) {
            logger.error("❌ Error closing database connection:", dbErr)
            // Continue shutdown despite errors
        }

        logger.info("👋 Shutdown complete")
        process.exit(0)
    } catch (err) {
        logger.error("❌ Critical error during shutdown:", err)
        process.exit(1)
    }
}

// Start the controller
startController()
