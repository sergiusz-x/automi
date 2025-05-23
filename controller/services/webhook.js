const { WebhookClient, EmbedBuilder } = require("discord.js")
const config = require("../utils/config")
const logger = require("../utils/logger")
const fs = require("fs")
const path = require("path")

// Initialize Discord webhook client
const webhookUrl = config.discord?.webhookUrl
const webhook = webhookUrl ? new WebhookClient({ url: webhookUrl }) : null

if (!webhook || webhookUrl === "") {
    logger.warn("❌ Discord webhook URL is not configured. Notifications will be skipped.")
}

/**
 * Format duration in a human-readable way
 * @param {number} ms Time in milliseconds
 * @returns {string} Formatted duration string
 */
function formatDuration(ms) {
    if (!ms || ms < 0) return "0ms"

    const days = Math.floor(ms / (24 * 60 * 60 * 1000))
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000))
    const seconds = Math.floor((ms % (60 * 1000)) / 1000)
    const milliseconds = ms % 1000

    let result = ""
    if (days > 0) result += `${days}d `
    if (hours > 0) result += `${hours}h `
    if (minutes > 0) result += `${minutes}m `
    if (seconds > 0) result += `${seconds}s `
    if (milliseconds > 0) result += `${milliseconds}ms`

    return result.trim()
}

/**
 * Get color for task status
 * @param {string} status Task status
 * @returns {number} Discord color code
 */
function getStatusColor(status) {
    switch (status.toLowerCase()) {
        case "success":
            return "#00ff00" // Green
        case "error":
            return "#ff0000" // Red
        case "running":
            return "#ffff00" // Yellow
        default:
            return "#808080" // Gray
    }
}

/**
 * Send task result to Discord webhook
 * @param {Object} data Task result data
 * @returns {Promise<boolean>} Success status
 */
async function sendTaskResult(data) {
    if (!webhook) {
        logger.debug("🔍 No webhook configured - skipping notification")
        return false
    }

    try {
        logger.info(`📤 Preparing Discord webhook for task "${data.taskName}"`)

        const embed = new EmbedBuilder()
            .setTitle(`Task: ${data.taskName}`)
            .setDescription(`Execution completed on **${data.agentId}**`)
            .setColor(getStatusColor(data.status))
            .setTimestamp()
            .addFields([
                {
                    name: "Status",
                    value: data.status.toUpperCase(),
                    inline: true
                },
                {
                    name: "Duration",
                    value: formatDuration(data.durationMs),
                    inline: true
                }
            ])

        if (data.stdout) {
            embed.addFields([
                {
                    name: "Output",
                    value: `\`\`\`\n${data.stdout.slice(0, 1000)}${data.stdout.length > 1000 ? "\n..." : ""}\n\`\`\``
                }
            ])
        }

        if (data.stderr) {
            embed.addFields([
                {
                    name: "Errors",
                    value: `\`\`\`\n${data.stderr.slice(0, 1000)}${data.stderr.length > 1000 ? "\n..." : ""}\n\`\`\``
                }
            ])
        }

        // Prepare send options, mention everyone on error status
        const sendOptions = { embeds: [embed] }
        if (data.status && data.status.toLowerCase() === "error") {
            sendOptions.content = `@everyone Error on task "${data.taskName}"!`
        }

        await webhook.send(sendOptions)

        logger.info(`✅ Webhook notification sent for task "${data.taskName}"`)
        return true
    } catch (err) {
        logger.error(`❌ Failed to send Discord webhook:`, err)
        return false
    }
}

/**
 * Send error log report to Discord webhook
 * @param {string} logFilePath - Path to the log file to attach
 * @returns {Promise<boolean>} Success status
 */
async function sendErrorLogReport(logFilePath) {
    if (!webhook) {
        logger.debug("🔍 No webhook configured - skipping error report")
        return false
    }

    logger.info(`📤 Preparing error log report for Discord webhook`)

    // Read log file for attachment if exists
    let logContent = null
    try {
        if (fs.existsSync(logFilePath)) {
            // Read up to 1MB of logs to avoid Discord attachment limits
            const stats = fs.statSync(logFilePath)
            const fileSize = Math.min(stats.size, 1024 * 1024)
            const buffer = Buffer.alloc(fileSize)

            const fd = fs.openSync(logFilePath, "r")
            fs.readSync(fd, buffer, 0, fileSize, stats.size - fileSize)
            fs.closeSync(fd)

            logContent = buffer.toString("utf8")
        }
    } catch (err) {
        logger.error(`❌ Failed to read log file for error report:`, err)
    }

    try {
        const embed = new EmbedBuilder()
            .setTitle("🚨 Error Report")
            .setDescription("Errors have been detected in the system today.")
            .setColor("#ff0000") // Red
            .setTimestamp()
            .addFields([
                {
                    name: "Log Date",
                    value: path.basename(logFilePath).replace("controller-", "").replace(".log", ""),
                    inline: true
                }
            ])

        await webhook.send({
            content: "@everyone Error report!",
            embeds: [embed],
            files: logContent
                ? [
                      {
                          attachment: Buffer.from(logContent),
                          name: path.basename(logFilePath)
                      }
                  ]
                : []
        })

        logger.info(`✅ Error report sent to Discord webhook`)
        return true
    } catch (err) {
        logger.error(`❌ Failed to send error report to Discord webhook:`, err)
        return false
    }
}

module.exports = {
    sendTaskResult,
    sendErrorLogReport
}
