/**
 * Task Status Command
 * Shows detailed task status and execution history
 */
const {
    SlashCommandSubcommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")
const agents = require("../../../core/agents")
const taskManager = require("../../../core/taskManager")

/**
 * Calculate success rate from execution records
 * @param {Array} runs Array of execution records
 * @returns {string} Formatted success rate
 */
function calculateSuccessRate(runs) {
    if (runs.length === 0) return "N/A"
    const successful = runs.filter(r => r.status === "success").length
    const rate = (successful / runs.length) * 100
    return `${rate.toFixed(1)}%`
}

/**
 * Calculate average duration from execution records
 * @param {Array} runs Array of execution records
 * @returns {string} Formatted average duration
 */
function calculateAverageDuration(runs) {
    if (runs.length === 0) return "N/A"
    const validRuns = runs.filter(r => r.durationMs)
    if (validRuns.length === 0) return "N/A"
    const average = validRuns.reduce((sum, r) => sum + r.durationMs, 0) / validRuns.length
    return `${Math.round(average)}ms`
}

/**
 * Create task status embed
 * @param {Object} task Task record
 * @param {Array} runs Recent execution records
 * @returns {EmbedBuilder} Discord embed
 */
function createStatusEmbed(task, runs) {
    const agentOnline = agents.isAgentOnline(task.agentId)
    const recentRuns = runs.slice(0, 5) // Show last 5 runs in detail

    const embed = new EmbedBuilder()
        .setTitle(`Task Status: ${task.name}`)
        .setColor(task.enabled ? "#00ff00" : "#ff0000")
        .addFields([
            {
                name: "Configuration",
                value: [
                    `**Type:** ${task.type}`,
                    `**Agent:** ${task.agentId} (${agentOnline ? "🟢 Online" : "🔴 Offline"})`,
                    `**Status:** ${task.enabled ? "✅ Enabled" : "❌ Disabled"}`,
                    `**Schedule:** ${task.schedule || "Manual trigger only"}`
                ].join("\n")
            },
            {
                name: "Statistics (Last 24h)",
                value: [
                    `**Total Runs:** ${runs.length}`,
                    `**Success Rate:** ${calculateSuccessRate(runs)}`,
                    `**Average Duration:** ${calculateAverageDuration(runs)}`
                ].join("\n")
            }
        ])

    // Add recent executions
    if (recentRuns.length > 0) {
        const recentRunsField = recentRuns
            .map(run => {
                const status = run.status === "success" ? "✅" : "❌"
                const timestamp = Math.floor(run.createdAt.getTime() / 1000)
                const duration = run.durationMs ? `${run.durationMs}ms` : "N/A"
                return `${status} <t:${timestamp}:t> (${duration})`
            })
            .join("\n")

        embed.addFields([
            {
                name: "Recent Executions",
                value: recentRunsField
            }
        ])
    } else {
        embed.addFields([
            {
                name: "Recent Executions",
                value: "*No recent executions*"
            }
        ])
    }

    // Add error details if available
    const lastError = recentRuns.find(r => r.status === "error")
    if (lastError && lastError.stderr) {
        embed.addFields([
            {
                name: "Last Error",
                value: `\`\`\`\n${lastError.stderr.slice(0, 1000)}\n\`\`\``
            }
        ])
    }

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("status")
        .setDescription("Show task status and recent executions")
        .addStringOption(option =>
            option.setName("name").setDescription("Task name").setRequired(true).setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
            const tasks = await db.Task.findAll({
                attributes: ["name"],
                where: {
                    name: {
                        [db.Sequelize.Op.like]: `%${focused}%`
                    }
                },
                limit: 25
            })

            await interaction.respond(
                tasks.map(task => ({
                    name: task.name,
                    value: task.name
                }))
            )
        } catch (err) {
            logger.error("❌ Task autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        await interaction.deferReply()

        try {
            const taskName = interaction.options.getString("name")

            // Find task
            const task = await db.Task.findOne({
                where: { name: taskName }
            })

            if (!task) {
                await interaction.editReply({
                    content: `❌ Task \`${taskName}\` not found.`,
                    flags: [MessageFlags.Ephemeral]
                })
                return
            }

            // Get recent executions
            const recentRuns = await db.TaskRun.findAll({
                where: {
                    taskId: task.id,
                    createdAt: {
                        [db.Sequelize.Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000)
                    }
                },
                order: [["createdAt", "DESC"]]
            })

            // Create run button if task is enabled
            const components = []
            if (task.enabled && agents.isAgentOnline(task.agentId)) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`run-task-${task.name}`)
                        .setLabel("Run Now")
                        .setStyle(ButtonStyle.Primary)
                )
                components.push(row)
            }

            // Send response
            const embed = createStatusEmbed(task, recentRuns)
            const message = await interaction.editReply({
                embeds: [embed],
                components
            })

            // Handle run button if present
            if (components.length > 0) {
                const collector = message.createMessageComponentCollector({
                    filter: i => i.customId === `run-task-${task.name}` && i.user.id === interaction.user.id,
                    time: 60000 // 1 minute
                })

                collector.on("collect", async i => {
                    try {
                        await i.update({
                            content: "🚀 Triggering task execution...",
                            components: []
                        })

                        // Actually run the task
                        logger.info(`Manually triggering task: ${task.name}`)
                        await taskManager.runTask(task.id)

                        await i.editReply({
                            content: `✅ Task \`${task.name}\` has been triggered. Check logs for execution results.`,
                            embeds: [embed],
                            components: []
                        })
                    } catch (err) {
                        logger.error(`❌ Failed to run task ${task.name}:`, err)
                        await i.editReply({
                            content: `❌ Failed to run task: ${err.message}`,
                            embeds: [embed],
                            components: []
                        })
                    }
                })

                collector.on("end", collected => {
                    if (collected.size === 0) {
                        interaction
                            .editReply({
                                embeds: [embed],
                                components: []
                            })
                            .catch(() => {})
                    }
                })
            }
        } catch (err) {
            logger.error("❌ Failed to show task status:", err)
            await interaction.editReply({
                content: "❌ Failed to retrieve task status.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
