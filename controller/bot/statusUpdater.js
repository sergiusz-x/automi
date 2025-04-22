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
 * @returns {Array<Object>} Array of upcoming execution dates with metadata
 */
function getNextRunTimes(cronExpression, daysToShow = 7) {
    if (!cronExpression) return []

    // Try using the fallback implementation directly
    // This avoids issues with the cron-parser library
    return getFallbackRunTimes(cronExpression, daysToShow)
}

/**
 * Fallback implementation for calculating run times using node-cron
 * @param {string} cronExpression Cron expression
 * @param {number} daysToShow Number of days to look ahead
 * @returns {Array<Object>} Array of upcoming execution dates with metadata
 */
function getFallbackRunTimes(cronExpression, daysToShow = 7) {
    try {
        const cron = require("node-cron")

        if (!cron.validate(cronExpression)) {
            logger.warn(`⚠️ Invalid cron expression: ${cronExpression}`)
            return []
        }

        // Output array
        const results = []

        // Current time
        const now = new Date()

        // For each day in the range
        for (let day = 0; day < daysToShow; day++) {
            // Base date for this day at midnight
            const baseDate = new Date(now)
            baseDate.setDate(now.getDate() + day)
            baseDate.setHours(0, 0, 0, 0)

            // Parse cron expression parts
            const parts = cronExpression.split(" ")
            if (parts.length !== 5) continue

            const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

            // Check if this date matches the day constraints
            const thisDayOfMonth = baseDate.getDate()
            const thisMonth = baseDate.getMonth() + 1 // 1-12 (JS months are 0-based)
            const thisDayOfWeek = baseDate.getDay() // 0-6 (0 is Sunday)

            if (
                !matchesCronPart(dayOfMonth, thisDayOfMonth) ||
                !matchesCronPart(month, thisMonth) ||
                !matchesCronDayOfWeek(dayOfWeek, thisDayOfWeek)
            ) {
                continue
            }

            // For each hour that matches
            for (let h = 0; h < 24; h++) {
                if (!matchesCronPart(hour, h)) continue

                // For each minute that matches
                for (let m = 0; m < 60; m++) {
                    if (!matchesCronPart(minute, m)) continue

                    const executionDate = new Date(baseDate)
                    executionDate.setHours(h, m, 0, 0)

                    const dayKey = executionDate.toISOString().split("T")[0]
                    const isPast = executionDate < now

                    results.push({
                        date: executionDate,
                        timestamp: Math.floor(executionDate.getTime() / 1000),
                        dayKey: dayKey,
                        isPast: isPast,
                        day: day // Store which day this is for easier debugging
                    })
                }
            }
        }

        // Sort results by date
        results.sort((a, b) => a.date - b.date)
        return results
    } catch (err) {
        logger.error(`❌ Fallback cron calculation failed:`, err)
        return []
    }
}

/**
 * Check if a value matches a cron part expression
 * @param {string} cronPart Cron part expression
 * @param {number} value Value to check
 * @returns {boolean} True if value matches the cron part
 */
function matchesCronPart(cronPart, value) {
    if (cronPart === "*") return true

    // Handle */n format (every n units)
    if (cronPart.includes("*/")) {
        const divisor = parseInt(cronPart.split("/")[1], 10)
        return value % divisor === 0
    }

    // Handle ranges (e.g., 1-5)
    if (cronPart.includes("-")) {
        const [start, end] = cronPart.split("-").map(Number)
        return value >= start && value <= end
    }

    // Handle lists (e.g., 1,3,5)
    if (cronPart.includes(",")) {
        return cronPart.split(",").map(Number).includes(value)
    }

    // Simple number comparison
    return parseInt(cronPart, 10) === value
}

/**
 * Special handler for day of week in cron
 * @param {string} cronDayOfWeek Cron day of week part (0-6, where 0 is Sunday)
 * @param {number} dayOfWeek JavaScript day of week (0-6, where 0 is Sunday)
 * @returns {boolean} True if day of week matches
 */
function matchesCronDayOfWeek(cronDayOfWeek, dayOfWeek) {
    // If * or 7 (both mean all days)
    if (cronDayOfWeek === "*" || cronDayOfWeek === "7") return true

    // Convert 7 to 0 (both represent Sunday in different systems)
    const normalizedCronPart = cronDayOfWeek.replace(/7/g, "0")

    return matchesCronPart(normalizedCronPart, dayOfWeek)
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
async function createUpcomingTasksFields(tasks, daysToShow = 7) {
    try {
        // Get current date in server's local timezone
        const now = new Date()
        logger.debug(`📅 Calendar generation started at: ${now.toISOString()}`)

        // Initialize days map for grouping tasks
        const dayGroups = []

        // Get today's date in server local timezone (YYYY-MM-DD)
        const todayKey = new Date().toLocaleDateString("en-CA") // format: YYYY-MM-DD
        logger.debug(`📅 Today's key date: ${todayKey}`)

        // Setup days we want to display
        for (let i = 0; i < daysToShow; i++) {
            // Create date for day i, starting with today
            const dayDate = new Date()
            dayDate.setDate(dayDate.getDate() + i)

            // Get the day key in local time zone (YYYY-MM-DD)
            const dayKey = dayDate.toLocaleDateString("en-CA")

            // Store in array to maintain order
            dayGroups.push({
                dayKey,
                date: dayDate,
                tasks: [],
                dayNumber: i
            })

            logger.debug(`📅 Day ${i}: ${dayKey} (${dayDate.toDateString()})`)
        }

        // Get all task runs from today onwards to check for completed tasks
        const startTime = new Date(now)
        startTime.setHours(0, 0, 0, 0)

        // Get ALL task runs for today, not just the main tasks
        const allTaskRuns = await db.TaskRun.findAll({
            where: {
                createdAt: {
                    [db.Sequelize.Op.gte]: startTime
                }
            },
            attributes: ["taskId", "status", "createdAt"]
        })

        // Group task runs by task ID for faster lookup
        const taskRunsByTaskId = new Map()
        allTaskRuns.forEach(run => {
            if (!taskRunsByTaskId.has(run.taskId)) {
                taskRunsByTaskId.set(run.taskId, [])
            }
            taskRunsByTaskId.get(run.taskId).push(run)
        })

        // Fetch all task dependencies for displaying in the calendar
        const allDependencies = await db.TaskDependency.findAll({
            include: [
                {
                    model: db.Task,
                    as: "childTask",
                    attributes: ["id", "name", "type", "agentId", "enabled"]
                }
            ]
        })

        // Group dependencies by parent task ID
        const dependenciesByParentId = new Map()
        allDependencies.forEach(dep => {
            if (!dependenciesByParentId.has(dep.parentTaskId)) {
                dependenciesByParentId.set(dep.parentTaskId, [])
            }
            dependenciesByParentId.get(dep.parentTaskId).push({
                childTask: dep.childTask,
                condition: dep.condition
            })
        })

        logger.debug(`📅 Processing ${tasks.length} tasks for calendar...`)

        // Process each task for the calendar
        for (const task of tasks) {
            if (!task.schedule || !task.enabled) continue

            // Get upcoming execution times
            const executions = getNextRunTimes(task.schedule, daysToShow)

            if (executions.length === 0) {
                logger.debug(`⚠️ No execution times found for task ${task.name} with schedule ${task.schedule}`)
                continue
            }

            // Get this task's runs
            const taskRuns = taskRunsByTaskId.get(task.id) || []

            // Process each execution time
            for (const execution of executions) {
                const { date, timestamp, isPast } = execution

                // Get day key in local timezone format to match our day groups
                const executionDate = new Date(date)
                const dayKey = executionDate.toLocaleDateString("en-CA")

                // Find the day group for this execution
                const dayGroup = dayGroups.find(group => group.dayKey === dayKey)

                if (!dayGroup) {
                    logger.debug(`⚠️ Day key ${dayKey} not found in day groups for task ${task.name}`)
                    continue
                }

                // Check if this task has been completed at this time
                const isCompleted = taskRuns.some(run => {
                    const runTime = new Date(run.createdAt)
                    const timeDiff = Math.abs(runTime - executionDate)
                    return timeDiff <= 10 * 60 * 1000 && run.status !== "pending" && run.status !== "running"
                })

                // Get the task's dependencies
                const dependencies = dependenciesByParentId.get(task.id) || []

                // Add to the appropriate day group
                dayGroup.tasks.push({
                    id: task.id,
                    name: task.name,
                    timestamp,
                    formattedTime: executionDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                    type: task.type,
                    agentId: task.agentId,
                    completed: isCompleted,
                    parentCompleted: isCompleted, // Store parent completion status for children
                    isPast,
                    dependencies
                })
            }
        }

        // Create fields for Discord embed
        const fields = []

        // Get condition emoji for dependencies
        function getConditionEmoji(condition) {
            switch (condition) {
                case "on:success":
                    return "✅"
                case "on:error":
                    return "❌"
                case "always":
                default:
                    return "⏭️"
            }
        }

        // Process each day in the original order
        for (let i = 0; i < dayGroups.length; i++) {
            const dayGroup = dayGroups[i]
            const isToday = i === 0

            // Always show today, even with no tasks
            // For other days, only show if they have tasks
            if (!isToday && dayGroup.tasks.length === 0) continue

            // Sort tasks by time
            dayGroup.tasks.sort((a, b) => a.timestamp - b.timestamp)

            // Format the day heading with Discord timestamp
            const dayTimestamp = Math.floor(dayGroup.date.getTime() / 1000)

            // Create task list text
            let taskList = ""

            if (dayGroup.tasks.length > 0) {
                for (const task of dayGroup.tasks) {
                    const typeEmoji = getTaskTypeEmoji(task.type)
                    const shouldStrikethrough = task.isPast && task.completed

                    // Add the main task
                    taskList += `${typeEmoji} ${shouldStrikethrough ? "~~" : ""}<t:${task.timestamp}:t> ${task.name} (${
                        task.agentId
                    })${shouldStrikethrough ? "~~" : ""}\n`

                    // Add dependencies if any
                    if (task.dependencies && task.dependencies.length > 0) {
                        for (const dep of task.dependencies) {
                            if (dep.childTask && dep.childTask.enabled) {
                                const condEmoji = getConditionEmoji(dep.condition)
                                const depTypeEmoji = getTaskTypeEmoji(dep.childTask.type)

                                // Simplified logic - if the main task is completed and crossed out,
                                // dependent tasks should also be crossed out
                                const depStrikethrough = shouldStrikethrough

                                taskList += `> ${condEmoji} ${depTypeEmoji} ${depStrikethrough ? "~~" : ""}${
                                    dep.childTask.name
                                } (${dep.childTask.agentId})${depStrikethrough ? "~~" : ""}\n`
                            }
                        }
                    }
                }
            } else {
                taskList = "No scheduled tasks"
            }

            // Truncate if needed
            if (taskList.length > 1020) {
                taskList = taskList.substring(0, 1000) + "\n... (more tasks not shown)"
            }

            // Add field to results
            fields.push({
                name: `📅 <t:${dayTimestamp}:F>`,
                value: taskList,
                inline: false
            })

            logger.debug(`📅 Added field for day ${dayGroup.dayKey} with ${dayGroup.tasks.length} tasks`)
        }

        // If we have no fields at all, add a message
        if (fields.length === 0) {
            fields.push({
                name: "📅 Calendar",
                value: "No scheduled tasks found.",
                inline: false
            })
        }

        return fields
    } catch (err) {
        logger.error(`❌ Error creating calendar fields:`, err)
        return [
            {
                name: "📅 Calendar Error",
                value: "Failed to create calendar. Check logs for details.",
                inline: false
            }
        ]
    }
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
    const upcomingTasksFields = await createUpcomingTasksFields(scheduledTasks, 7)
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
