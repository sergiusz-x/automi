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
        // Initialize database connection
        logger.info("📊 Connecting to database...")
        await db.sequelize.authenticate()
        logger.info("✅ Database connection established")

        // Synchronize database models
        logger.info("🔄 Synchronizing database models...")
        await db.sequelize.sync({ alter: true })
        logger.info("✅ Database models synchronized")

        // Start WebSocket server for agent connections
        logger.info("🌐 Initializing WebSocket server...")
        await startWebSocketServer()
        logger.info("✅ WebSocket server started")

        // Initialize Discord bot
        logger.info("🤖 Starting Discord bot...")
        await startDiscordBot()
        logger.info("✅ Discord bot initialized")

        // Start task scheduler
        logger.info("⏰ Initializing task scheduler...")
        await startScheduler()
        logger.info("✅ Task scheduler started")

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
async function gracefulShutdown() {
    logger.info("🛑 Shutting down Automi Controller...")
    
    try {
        // 1. Set the global shutdown flag to prevent DB operations during shutdown
        global.isShuttingDown = true;
        
        // 2. Stop task scheduler
        logger.info("⏰ Stopping task scheduler...")
        startScheduler.stopAllJobs()
        logger.info("✅ Task scheduler stopped")
        
        // 3. Update all agent statuses in database to offline in one batch operation
        logger.info("📊 Updating agent statuses in database...")
        try {
            const allAgents = await db.Agent.findAll({ where: { status: 'online' } });
            if (allAgents.length > 0) {
                await db.Agent.update(
                    { status: "offline" },
                    { where: { status: "online" } }
                );
                logger.info(`✅ Updated ${allAgents.length} agents to offline status in database`);
            }
        } catch (dbErr) {
            logger.error("❌ Failed to update agent statuses:", dbErr.message);
        }
        
        // 4. Disconnect agents - notify them but don't update DB
        logger.info("🔌 Disconnecting agents...")
        const agents = require("./core/agents")
        agents.disconnectAll(true) // true = silent mode, avoid DB updates
        logger.info("✅ Agents notified about disconnection")
        
        // 5. Close WebSocket server
        logger.info("🌐 Stopping WebSocket server...")
        await require("./core/ws").shutdown()
        logger.info("✅ WebSocket server stopped")
        
        // 6. Close database connection
        logger.info("📊 Closing database connection...")
        await db.sequelize.close()
        logger.info("✅ Database connection closed")

        logger.info("👋 Shutdown complete")
        process.exit(0)
    } catch (err) {
        logger.error("❌ Error during shutdown:", err)
        process.exit(1)
    }
}

// Start the controller
startController()
