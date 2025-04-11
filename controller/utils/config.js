/**
 * Configuration Management Module
 * Loads and validates application configuration from config.json
 */
const fs = require("fs")
const path = require("path")
const logger = require("./logger")

// Path to the configuration file
const configPath = path.join(__dirname, "..", "config.json")

let config

/**
 * Validates the database configuration section
 * @param {Object} dbConfig Database configuration object
 * @throws {Error} If required fields are missing
 */
function validateDatabaseConfig(dbConfig) {
    const required = ["host", "port", "username", "name"]
    const missing = required.filter(field => !dbConfig[field])

    if (missing.length) {
        throw new Error(`Missing required database config fields: ${missing.join(", ")}`)
    }

    if (typeof dbConfig.port !== "number" || dbConfig.port <= 0) {
        throw new Error("Database port must be a positive number")
    }
}

/**
 * Validates the WebSocket configuration section
 * @param {Object} wsConfig WebSocket configuration object
 * @throws {Error} If configuration is invalid
 */
function validateWebSocketConfig(wsConfig) {
    if (!wsConfig.port || typeof wsConfig.port !== "number") {
        throw new Error("WebSocket port must be a positive number")
    }

    if (wsConfig.useSSL) {
        if (!wsConfig.sslCertPath || !wsConfig.sslKeyPath) {
            throw new Error("SSL cert and key paths are required when SSL is enabled")
        }

        if (!fs.existsSync(path.resolve(__dirname, "..", wsConfig.sslCertPath))) {
            throw new Error(`SSL certificate not found: ${wsConfig.sslCertPath}`)
        }

        if (!fs.existsSync(path.resolve(__dirname, "..", wsConfig.sslKeyPath))) {
            throw new Error(`SSL key not found: ${wsConfig.sslKeyPath}`)
        }
    }
}

/**
 * Validates the Discord configuration section
 * @param {Object} discordConfig Discord configuration object
 * @throws {Error} If required fields are missing
 */
function validateDiscordConfig(discordConfig) {
    const required = ["botToken", "clientId", "guildId"]
    const missing = required.filter(field => !discordConfig[field])

    if (missing.length) {
        throw new Error(`Missing required Discord config fields: ${missing.join(", ")}`)
    }
}

try {
    // Read and parse the configuration file
    logger.info("📚 Loading configuration...")
    const raw = fs.readFileSync(configPath, "utf-8")
    config = JSON.parse(raw)

    // Validate required configuration sections
    if (!config.websocket || !config.discord || !config.database) {
        throw new Error("Missing required config sections: websocket, discord, database")
    }

    // Validate each section
    validateDatabaseConfig(config.database)
    validateWebSocketConfig(config.websocket)
    validateDiscordConfig(config.discord)

    logger.info("✅ Configuration loaded and validated successfully")
} catch (err) {
    logger.error("❌ Configuration error:", err.message)
    process.exit(1)
}

module.exports = config
