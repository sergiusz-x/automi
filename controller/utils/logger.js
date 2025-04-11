/**
 * Logging Utility Module
 * Provides consistent logging across the controller application with file rotation
 */
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

// Path for storing error state
const errorStatePath = path.join(logsDir, ".error_state.json")

// Define log format for console and file
const logFormat = format.printf(info => {
    return `[${info.timestamp}] ${info.message}`
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
        // Console transport with colors
        new transports.Console({
            format: format.combine(
                format.colorize({ all: true }),
                format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
                logFormat
            )
        }),
        // Rotating file transport with compression
        new transports.DailyRotateFile({
            filename: path.join(logsDir, "controller-%DATE%.log"),
            datePattern: "YYYY-MM-DD",
            zippedArchive: true,
            maxSize: "20m",
            maxFiles: "14d"
        })
    ]
})

// Load error state from file if exists
let errorsOccurred = false
let lastErrorReportDate = null

// Load previous error state if exists
try {
    if (fs.existsSync(errorStatePath)) {
        const errorState = JSON.parse(fs.readFileSync(errorStatePath, "utf8"))
        const today = new Date().toISOString().split("T")[0]

        // Only restore error state if it's from today
        if (errorState.date === today) {
            errorsOccurred = errorState.errorsOccurred || false
            lastErrorReportDate = errorState.lastErrorReportDate || null

            if (errorsOccurred) {
                // Use winstonLogger directly since the logger object isn't created yet
                winstonLogger.warn(`⚠️ Restored error state from previous run - errors occurred today`)
            }
        } else {
            // Clean up old state file if it's not from today
            fs.unlinkSync(errorStatePath)
        }
    }
} catch (err) {
    // Use winstonLogger directly since the logger object isn't created yet
    winstonLogger.error(`❌ Failed to load error state: ${err.message}`)
}

/**
 * Save current error state to file
 */
function saveErrorState() {
    try {
        const errorState = {
            date: new Date().toISOString().split("T")[0],
            errorsOccurred,
            lastErrorReportDate
        }

        fs.writeFileSync(errorStatePath, JSON.stringify(errorState, null, 4), "utf8")
    } catch (err) {
        winstonLogger.error(`❌ Failed to save error state: ${err.message}`)
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
    },

    /**
     * Log error message
     * @param {...any} args - Message and additional data to log
     */
    error: (...args) => {
        const message = args.map(stringifyArg).join(" ")
        winstonLogger.error(message)

        // Set error flag and schedule report
        errorsOccurred = true
        saveErrorState() // Save state immediately when error occurs
        scheduleErrorReportCheck()
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

    /**
     * Get current log file path for today
     * @returns {string} Path to today's log file
     */
    getCurrentLogFile: () => {
        const today = new Date().toISOString().split("T")[0]
        return path.join(logsDir, `controller-${today}.log`)
    },

    /**
     * Check if errors occurred today and reset flag
     * @returns {boolean} Whether errors occurred today
     */
    checkAndResetErrorFlag: () => {
        const hadErrors = errorsOccurred
        errorsOccurred = false
        saveErrorState() // Update persisted state
        return hadErrors
    }
}

/**
 * Check if it's time to send an error report
 * Scheduled to run once at the end of the day
 */
function scheduleErrorReportCheck() {
    const now = new Date()
    const today = now.toISOString().split("T")[0]

    // Only schedule once per day
    if (lastErrorReportDate === today) {
        return
    }

    // Calculate time until end of day (23:55)
    const endOfDay = new Date(now)
    endOfDay.setHours(23, 55, 0, 0)

    let timeUntilEndOfDay = endOfDay - now
    if (timeUntilEndOfDay < 0) {
        // Already past end of day, schedule for tomorrow
        endOfDay.setDate(endOfDay.getDate() + 1)
        timeUntilEndOfDay = endOfDay - now
    }

    // Also check if we should send a report immediately
    // if system was restarted after 23:55 and before midnight
    const shouldSendImmediately =
        now.getHours() >= 23 && now.getMinutes() >= 55 && lastErrorReportDate !== today && errorsOccurred

    if (shouldSendImmediately) {
        logger.info("🔄 System restarted after scheduled report time - sending error report immediately")
        sendErrorReport()
        return
    }

    // Schedule report for end of day
    logger.debug(`🕒 Scheduling error report check for ${endOfDay.toISOString()}`)
    setTimeout(() => {
        sendErrorReport()
        lastErrorReportDate = new Date().toISOString().split("T")[0]
        saveErrorState() // Update persisted state after sending report
    }, timeUntilEndOfDay)
}

/**
 * Send an error report to webhook if errors occurred
 * Will attempt to send a notification with log file attachments
 */
function sendErrorReport() {
    // Only proceed if errors occurred
    if (!errorsOccurred) {
        return
    }

    logger.info("📊 Sending daily error report")

    // Load webhook service dynamically to avoid circular dependencies
    const webhookService = require("../services/webhook")

    // Send error report via webhook
    webhookService
        .sendErrorLogReport(logger.getCurrentLogFile())
        .then(() => {
            // Reset error flag only after successful report
            errorsOccurred = false
            lastErrorReportDate = new Date().toISOString().split("T")[0]
            saveErrorState() // Update persisted state
        })
        .catch(err => winstonLogger.error(`❌ Failed to send error report: ${err}`))
}

// Schedule error report check on startup if errors occurred
if (errorsOccurred) {
    scheduleErrorReportCheck()
}

module.exports = logger
