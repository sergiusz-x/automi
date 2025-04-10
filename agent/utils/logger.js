/**
 * Logging Utility Module
 * Provides consistent logging across the agent application
 */
const chalk = require("chalk")
const fs = require("fs")
const path = require("path")
const winston = require("winston")
const { format, createLogger, transports } = winston
require("winston-daily-rotate-file")

// Ensure logs directory exists
const logsDir = path.join(__dirname, "..", "logs")
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
}

// Define log format
const logFormat = format.printf(({ level, message, timestamp }) => {
    return `[${timestamp}] ${message}`
})

// Create Winston logger with file rotation
const winstonLogger = createLogger({
    format: format.combine(format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), logFormat),
    transports: [
        new transports.Console({
            format: format.combine(
                format.colorize({ all: true }),
                format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
                logFormat
            )
        }),
        new transports.DailyRotateFile({
            filename: path.join(logsDir, "agent-%DATE%.log"),
            datePattern: "YYYY-MM-DD",
            zippedArchive: true,
            maxSize: "20m",
            maxFiles: "14d"
        })
    ]
})

/**
 * Logger instance with different severity levels
 * Uses Winston for file and console logging with proper formatting
 */
const logger = {
    /**
     * Log informational message
     * @param {...any} args - Message and additional data to log
     */
    info: (...args) => {
        const message = args.map(arg => (typeof arg === "object" ? JSON.stringify(arg) : arg)).join(" ")
        winstonLogger.info(message)
    },

    /**
     * Log warning message
     * @param {...any} args - Message and additional data to log
     */
    warn: (...args) => {
        const message = args.map(arg => (typeof arg === "object" ? JSON.stringify(arg) : arg)).join(" ")
        winstonLogger.warn(message)
    },

    /**
     * Log error message
     * @param {...any} args - Message and additional data to log
     */
    error: (...args) => {
        const message = args.map(arg => (typeof arg === "object" ? JSON.stringify(arg) : arg)).join(" ")
        winstonLogger.error(message)
    },

    /**
     * Log debug message (only in debug mode)
     * @param {...any} args - Message and additional data to log
     */
    debug: (...args) => {
        if (process.env.DEBUG === "true") {
            const message = args.map(arg => (typeof arg === "object" ? JSON.stringify(arg) : arg)).join(" ")
            winstonLogger.debug(message)
        }
    }
}

module.exports = logger
