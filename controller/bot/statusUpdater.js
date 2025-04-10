const { EmbedBuilder, ActivityType } = require("discord.js")
const fs = require("fs")
const path = require("path")
const logger = require("../utils/logger")
const db = require("../db")
const agents = require("../core/agents")

const CONFIG_PATH = path.join(__dirname, "config/status-message.json")
const UPDATE_INTERVAL = 30000 // 30 seconds

// Track status message details
let statusMessage = null
let updateInterval = null

/**
 * Load status message configuration
 */
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, "utf8")
            return JSON.parse(raw)
        }
    } catch (err) {
        logger.warn("⚠️ Failed to load status message config:", err)
    }
    return null
}

/**
 * Format duration in a human-readable way
 */
function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
}

/**
 * Get statistics for both message and bot status
 */
async function getStats() {
    try {
        const [
            totalTasks,
            enabledTasks,
            totalAgents,
            runningTasks,
            last24hRuns,
            successfulRuns,
            failedRuns,
            recentRuns
        ] = await Promise.all([
            db.Task.count(),
            db.Task.count({ where: { enabled: true } }),
            db.Agent.count(),
            db.TaskRun.count({ 
                where: { 
                    status: "running",
                    startedAt: {
                        [db.Sequelize.Op.gte]: new Date(Date.now() - 5 * 60 * 1000) // Last 5 minutes
                    }
                } 
            }),
            db.TaskRun.count({ 
                where: { 
                    createdAt: {
                        [db.Sequelize.Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
                    }
                } 
            }),
            db.TaskRun.count({ 
                where: { 
                    status: "success",
                    createdAt: {
                        [db.Sequelize.Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
                    }
                } 
            }),
            db.TaskRun.count({ 
                where: { 
                    status: "error",
                    createdAt: {
                        [db.Sequelize.Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
                    }
                } 
            }),
            // Get 5 most recent task runs with task names
            db.TaskRun.findAll({
                include: [{
                    model: db.Task,
                    attributes: ['name']
                }],
                order: [['createdAt', 'DESC']],
                limit: 5
            })
        ])

        const onlineAgents = agents.listActiveAgents().length

        return {
            totalTasks,
            enabledTasks,
            totalAgents,
            onlineAgents,
            runningTasks,
            last24hRuns,
            successfulRuns,
            failedRuns,
            successRate: last24hRuns > 0 ? Math.round((successfulRuns / last24hRuns) * 100) : 0,
            recentRuns
        }
    } catch (err) {
        logger.error("❌ Failed to fetch statistics:", err)
        return null
    }
}

/**
 * Get status emoji for task result
 */
function getStatusEmoji(status) {
    switch (status.toLowerCase()) {
        case 'success': return '✅'
        case 'error': return '❌'
        case 'running': return '⚙️'
        case 'cancelled': return '⛔'
        default: return '❓'
    }
}

/**
 * Create status embed with current system information
 */
async function createStatusEmbed(stats) {
    // Format recent runs
    const recentRunsText = stats.recentRuns.map(run => {
        const timestamp = Math.floor(run.createdAt.getTime() / 1000)
        const duration = run.durationMs ? ` (${formatDuration(run.durationMs)})` : ''
        return `${getStatusEmoji(run.status)} ${run.Task.name}${duration} - <t:${timestamp}:R>`
    }).join('\n')

    const now = Math.floor(Date.now() / 1000)
    const last24h = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)

    return new EmbedBuilder()
        .setTitle("📡 Automi System Status")
        .setDescription(`Statistics for period: <t:${last24h}:f> to <t:${now}:f>`)
        .setColor(0x00bcd4)
        .addFields([
            {
                name: "Tasks",
                value: `📋 Total: ${stats.totalTasks}
⚡ Active: ${stats.enabledTasks}
🔄 Running: ${stats.runningTasks}`,
                inline: true
            },
            {
                name: "Agents",
                value: `📡 Total: ${stats.totalAgents}
🟢 Online: ${stats.onlineAgents}
💤 Offline: ${stats.totalAgents - stats.onlineAgents}`,
                inline: true
            },
            {
                name: "Performance (24h)",
                value: `🔄 Total Runs: ${stats.last24hRuns}
✅ Successful: ${stats.successfulRuns}
❌ Failed: ${stats.failedRuns}
📊 Success Rate: ${stats.successRate}%`,
                inline: true
            },
            {
                name: "Recent Task Runs",
                value: recentRunsText || "No recent task runs",
                inline: false
            }
        ])
        .setFooter({ text: "Last updated" })
        .setTimestamp()
}

/**
 * Update both the status message and bot presence
 */
async function updateStatus(client) {
    try {
        const stats = await getStats()
        if (!stats) return

        // Update message if exists
        if (statusMessage) {
            try {
                const embed = await createStatusEmbed(stats)
                await statusMessage.edit({ embeds: [embed] })
                logger.debug("🔄 Status message updated")
            } catch (err) {
                logger.error("❌ Failed to update status message:", err)
                if (err.code === 10008) { // Unknown Message error
                    logger.warn("⚠️ Status message not found. Disabling updates.")
                    clearInterval(updateInterval)
                    statusMessage = null
                }
            }
        }

        // Update bot presence
        let status
        if (stats.runningTasks > 0) {
            status = `⚙️ Running ${stats.runningTasks} task${stats.runningTasks !== 1 ? 's' : ''}`
        } else {
            status = `✅ ${stats.enabledTasks}/${stats.totalTasks} tasks enabled`
        }

        const activity = `${stats.last24hRuns} runs (${stats.successRate}% success)`
        
        await client.user.setPresence({
            activities: [{
                name: activity,
                type: ActivityType.Custom
            }],
            status: stats.runningTasks > 0 ? "dnd" : "online"
        })

        logger.debug("🔄 Bot status updated")
    } catch (err) {
        logger.error("❌ Failed to update status:", err)
    }
}

/**
 * Initialize status message updates
 */
async function startStatusUpdater(client) {
    try {
        // Load message configuration
        const config = loadConfig()
        if (!config) {
            logger.warn("⚠️ No status message configured")
            return
        }

        // Get message channel
        const channel = await client.channels.fetch(config.channelId)
        if (!channel) {
            logger.error("❌ Status message channel not found")
            return
        }

        // Get or create status message
        try {
            statusMessage = await channel.messages.fetch(config.messageId)
            logger.info("✅ Found existing status message")
        } catch (err) {
            logger.warn("⚠️ Failed to fetch existing status message. Creating new one...")
            const stats = await getStats()
            if (!stats) return

            const embed = await createStatusEmbed(stats)
            statusMessage = await channel.send({ embeds: [embed] })

            // Save new message details
            fs.writeFileSync(
                CONFIG_PATH,
                JSON.stringify({
                    channelId: channel.id,
                    messageId: statusMessage.id
                }, null, 4)
            )
            logger.info("✅ Created new status message")
        }

        // Clear any existing interval
        if (updateInterval) {
            clearInterval(updateInterval)
        }

        // Create update function with client bound
        const boundUpdateStatus = () => updateStatus(client)
        
        // Start periodic updates
        updateInterval = setInterval(boundUpdateStatus, UPDATE_INTERVAL)
        logger.info("✅ Status updater initialized")

        // Do initial update
        await boundUpdateStatus()
    } catch (err) {
        logger.error("❌ Failed to initialize status updater:", err)
    }
}

module.exports = startStatusUpdater
