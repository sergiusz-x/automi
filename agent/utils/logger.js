/**
 * Logging Utility Module
 * Provides consistent logging across the agent application
 */
const fs = require("fs")
const path = require("path")
const winston = require("winston")
const { format, createLogger, transports } = winston
require("winston-daily-rotate-file")
const WebSocket = require("ws")

// Ensure logs directory exists
const logsDir = path.join(__dirname, "..", "logs")
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
}

// Define log format
const logFormat = format.printf(({ level, message, timestamp }) => {
    return `[${timestamp}] ${message}`
})

// Helper function to properly stringify objects and errors
function stringifyArg(arg) {
    if (arg instanceof Error) {
        return arg.stack || `${arg.name}: ${arg.message}`
    }
    if (typeof arg === "object") {
        try {
            return JSON.stringify(arg, Object.getOwnPropertyNames(arg))
        } catch (err) {
            return `[Unstringifiable Object: ${err.message}]`
        }
    }
    return String(arg)
}

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

// Add socket management
let socket = null
function setSocket(wsSocket) {
    socket = wsSocket
}

function sendErrorToController(level, message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
            JSON.stringify({
                type: "agent_error",
                payload: {
                    timestamp: new Date().toISOString(),
                    level,
                    error: message
                }
            })
        )
    }
}

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
        const message = args.map(stringifyArg).join(" ")
        winstonLogger.info(message)
    },

    /**
     * Log warning message
     * @param {...any} args - Message and additional data to log
     */
    warn: (...args) => {
        const message = args.map(stringifyArg).join(" ")
        winstonLogger.warn(message)
        sendErrorToController("warn", message)
    },

    /**
     * Log error message
     * @param {...any} args - Message and additional data to log
     */
    error: (...args) => {
        const message = args.map(stringifyArg).join(" ")
        winstonLogger.error(message)
        sendErrorToController("error", message)
    },

    /**
     * Log debug message (only in debug mode)
     * @param {...any} args - Message and additional data to log
     */
    debug: (...args) => {
        if (process.env.DEBUG === "true") {
            const message = args.map(stringifyArg).join(" ")
            winstonLogger.debug(message)
        }
    },

    setSocket
}

module.exports = logger
