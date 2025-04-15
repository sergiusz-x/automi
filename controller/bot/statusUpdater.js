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
                include: [
                    {
                        model: db.Task,
                        attributes: ["name"]
                    }
                ],
                order: [["createdAt", "DESC"]],
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
 * Calculate next run times for a task based on cron schedule
 * @param {string} cronExpression Cron expression
 * @param {number} daysToShow Number of days to look ahead
 * @returns {Array<Date>} Array of upcoming execution dates
 */
function getNextRunTimes(cronExpression, daysToShow = 3) {
    if (!cronExpression) return []

    try {
        const cron = require("node-cron")

        // Validate the cron expression
        if (!cron.validate(cronExpression)) {
            logger.warn(`⚠️ Invalid cron expression: ${cronExpression}`)
            return []
        }

        const dates = []
        const now = new Date()
        const endDate = new Date(now)
        endDate.setDate(endDate.getDate() + daysToShow)

        // Start from beginning of today, not from now
        const startOfToday = new Date(now)
        startOfToday.setHours(0, 0, 0, 0)

        // For each day
        for (let day = 0; day < daysToShow; day++) {
            const currentDate = new Date(startOfToday)
            currentDate.setDate(currentDate.getDate() + day)

            // For each hour of the day
            for (let hour = 0; hour < 24; hour++) {
                currentDate.setHours(hour)

                // For each minute of the hour
                for (let minute = 0; minute < 60; minute++) {
                    currentDate.setMinutes(minute, 0, 0)

                    // Check if the schedule matches this time
                    const parts = cronExpression.split(" ")
                    const cronMinute = parts[0]
                    const cronHour = parts[1]
                    const cronDayOfMonth = parts[2]
                    const cronMonth = parts[3]
                    const cronDayOfWeek = parts[4]

                    // Check minute
                    if (
                        cronMinute !== "*" &&
                        !cronMinute.includes(minute.toString()) &&
                        !evalCronPart(cronMinute, minute)
                    )
                        continue

                    // Check hour
                    if (cronHour !== "*" && !cronHour.includes(hour.toString()) && !evalCronPart(cronHour, hour))
                        continue

                    // Check day of month
                    if (
                        cronDayOfMonth !== "*" &&
                        !cronDayOfMonth.includes(currentDate.getDate().toString()) &&
                        !evalCronPart(cronDayOfMonth, currentDate.getDate())
                    )
                        continue

                    // Check month (0-11 in JS, 1-12 in cron)
                    if (
                        cronMonth !== "*" &&
                        !cronMonth.includes((currentDate.getMonth() + 1).toString()) &&
                        !evalCronPart(cronMonth, currentDate.getMonth() + 1)
                    )
                        continue

                    // Check day of week (0-6 in JS where 0 is Sunday, 0-6 in cron where 0 is Sunday)
                    if (
                        cronDayOfWeek !== "*" &&
                        !cronDayOfWeek.includes(currentDate.getDay().toString()) &&
                        !evalCronPart(cronDayOfWeek, currentDate.getDay())
                    )
                        continue

                    // All parts match, add this date
                    dates.push(new Date(currentDate))
                }
            }
        }

        return dates
    } catch (err) {
        logger.error(`❌ Error parsing cron expression: ${cronExpression}`, err)
        return []
    }
}

/**
 * Evaluate a cron part expression
 * @param {string} part Cron part expression
 * @param {number} value Current value to check
 * @returns {boolean} True if the value matches the cron part
 */
function evalCronPart(part, value) {
    // Handle */n format (every n units)
    if (part.includes("*/")) {
        const divisor = parseInt(part.split("/")[1])
        return value % divisor === 0
    }

    // Handle ranges (e.g., 1-5)
    if (part.includes("-")) {
        const [start, end] = part.split("-").map(Number)
        return value >= start && value <= end
    }

    // Handle lists (e.g., 1,3,5)
    if (part.includes(",")) {
        return part.split(",").map(Number).includes(value)
    }

    // Simple number comparison
    return parseInt(part) === value
}

/**
 * Get task emoji based on type
 * @param {string} type Task type
 * @returns {string} Emoji
 */
function getTaskTypeEmoji(type) {
    switch (type.toLowerCase()) {
        case "bash":
            return "🐚"
        case "python":
            return "🐍"
        case "node":
            return "📦"
        default:
            return "📄"
    }
}

/**
 * Create upcoming task schedule embed
 * @param {Array} tasks Task records with schedules
 * @param {number} daysToShow Number of days to look ahead
 * @returns {Object} Embed fields
 */
async function createUpcomingTasksFields(tasks, daysToShow = 3) {
    const fields = []
    const now = new Date()

    // Group tasks by day
    const tasksByDay = {}

    // Initialize days
    for (let i = 0; i < daysToShow; i++) {
        const date = new Date(now)
        date.setDate(date.getDate() + i)
        const dayKey = Math.floor(date.getTime() / 86400000) // Days since epoch
        tasksByDay[dayKey] = {
            date,
            tasks: []
        }
    }

    // Calculate upcoming runs for each task
    for (const task of tasks) {
        if (!task.schedule || !task.enabled) continue

        // Get all run times in the next N days
        const runTimes = getNextRunTimes(task.schedule, daysToShow)

        // Get recent run for this task to check if it's completed
        const recentRuns = await db.TaskRun.findAll({
            where: {
                taskId: task.id,
                createdAt: {
                    [db.Sequelize.Op.gte]: new Date(now.setHours(0, 0, 0, 0))
                }
            },
            order: [["createdAt", "DESC"]],
            limit: 5
        })

        // Map run times to days
        for (const runTime of runTimes) {
            const dayKey = Math.floor(runTime.getTime() / 86400000) // Days since epoch
            if (tasksByDay[dayKey]) {
                // Get timestamp for Discord formatting
                const timestamp = Math.floor(runTime.getTime() / 1000)

                // Check if this task already ran today at this time
                const taskCompleted = recentRuns.some(run => {
                    const runDate = new Date(run.createdAt)
                    // Compare hour and minute for same time check
                    return (
                        runDate.getHours() === runTime.getHours() &&
                        runDate.getMinutes() === runTime.getMinutes() &&
                        run.status !== "pending"
                    )
                })

                tasksByDay[dayKey].tasks.push({
                    name: task.name,
                    timestamp,
                    type: task.type,
                    agentId: task.agentId,
                    completed: taskCompleted
                })
            }
        }
    }

    // Create fields for each day
    for (const dayKey in tasksByDay) {
        const day = tasksByDay[dayKey]
        const dayTimestamp = Math.floor(day.date.getTime() / 1000)

        // Sort tasks by time
        day.tasks.sort((a, b) => a.timestamp - b.timestamp)

        // Create task list for this day
        let taskList =
            day.tasks.length > 0
                ? day.tasks
                      .map(t => {
                          const typeEmoji = getTaskTypeEmoji(t.type)
                          const task = `${typeEmoji} ${t.completed ? "~~" : ""}<t:${t.timestamp}:t> ${t.name} (${
                              t.agentId
                          })${t.completed ? "~~" : ""}`
                          return task
                      })
                      .join("\n")
                : "No scheduled tasks"

        // Limit character count if needed
        if (taskList.length > 1020) {
            taskList = taskList.substring(0, 1000) + "\n... (more tasks not shown)"
        }

        fields.push({
            name: `📅 <t:${dayTimestamp}:D>`,
            value: taskList,
            inline: false
        })
    }

    return fields
}

/**
 * Get status emoji for task result
 */
function getStatusEmoji(status) {
    switch (status.toLowerCase()) {
        case "success":
            return "✅"
        case "error":
            return "❌"
        case "running":
            return "⚙️"
        case "cancelled":
            return "⛔"
        default:
            return "❓"
    }
}

/**
 * Create status embed with current system information
 */
async function createStatusEmbed(stats) {
    // Format recent runs
    const recentRunsText = stats.recentRuns
        .map(run => {
            const timestamp = Math.floor(run.createdAt.getTime() / 1000)
            const duration = run.durationMs ? ` (${formatDuration(run.durationMs)})` : ""
            return `${getStatusEmoji(run.status)} ${run.Task.name}${duration} - <t:${timestamp}:R>`
        })
        .join("\n")

    const now = Math.floor(Date.now() / 1000)
    const last24h = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)

    // Create base embed
    const embed = new EmbedBuilder()
        .setTitle("📡 Automi System Status")
        .setDescription(`Statistics for period: <t:${last24h}:f> to <t:${now}:f>`)
        .setColor("#00bcd4")
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
            },
            {
                name: "📆 Scheduled Tasks Calendar",
                value: " ",
                inline: false
            }
        ])
        .setFooter({ text: "Last updated" })
        .setTimestamp()

    // Fetch scheduled tasks
    const scheduledTasks = await db.Task.findAll({
        where: {
            schedule: {
                [db.Sequelize.Op.ne]: null
            },
            enabled: true
        }
    })

    // Add upcoming tasks fields
    const upcomingTasksFields = await createUpcomingTasksFields(scheduledTasks, 3)
    embed.addFields(upcomingTasksFields)

    return embed
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
                if (err.code === 10008) {
                    // Unknown Message error
                    logger.warn("⚠️ Status message not found. Disabling updates.")
                    clearInterval(updateInterval)
                    statusMessage = null
                }
            }
        }

        // Update bot presence
        let status
        if (stats.runningTasks > 0) {
            status = `⚙️ Running ${stats.runningTasks} task${stats.runningTasks !== 1 ? "s" : ""}`
        } else {
            status = `✅ ${stats.enabledTasks}/${stats.totalTasks} tasks enabled`
        }

        const activity = `${stats.last24hRuns} runs (${stats.successRate}% success)`

        await client.user.setPresence({
            activities: [
                {
                    name: activity,
                    type: ActivityType.Custom
                }
            ],
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
                JSON.stringify(
                    {
                        channelId: channel.id,
                        messageId: statusMessage.id
                    },
                    null,
                    4
                )
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
