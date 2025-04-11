/**
 * Task Run Command
 * Handles manual task execution with real-time status updates
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
const taskManager = require("../../../core/taskManager")
const agents = require("../../../core/agents")

// Status update interval in ms
const UPDATE_INTERVAL = 2000

/**
 * Create execution status embed
 * @param {Object} task Task record
 * @param {Object} runData Execution data
 * @returns {EmbedBuilder} Discord embed
 */
function createStatusEmbed(task, runData = {}) {
    const embed = new EmbedBuilder()
        .setTitle(`Task Execution: ${task.name}`)
        .setColor("#00bcd4")
        .addFields([
            { name: "Agent", value: task.agentId, inline: true },
            { name: "Type", value: task.type, inline: true }
        ])

    if (runData.status) {
        const statusEmoji = {
            pending: "⏳",
            running: "⚙️",
            success: "✅",
            error: "❌",
            cancelled: "🚫"
        }[runData.status]

        embed.addFields([{ name: "Status", value: `${statusEmoji} ${runData.status.toUpperCase()}`, inline: true }])

        if (runData.durationMs) {
            embed.addFields([{ name: "Duration", value: `${runData.durationMs}ms`, inline: true }])
        }

        if (runData.stdout?.trim()) {
            embed.addFields([
                {
                    name: "Output",
                    value: `\`\`\`\n${runData.stdout.slice(0, 1000)}${
                        runData.stdout.length > 1000 ? "\n..." : ""
                    }\n\`\`\``
                }
            ])
        }

        if (runData.stderr?.trim()) {
            embed.addFields([
                {
                    name: "Errors",
                    value: `\`\`\`\n${runData.stderr.slice(0, 1000)}${
                        runData.stderr.length > 1000 ? "\n..." : ""
                    }\n\`\`\``
                }
            ])
        }
    } else {
        embed.setDescription("⏳ Preparing to execute task...")
    }

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("run")
        .setDescription("Run a task manually")
        .addStringOption(opt => opt.setName("name").setDescription("Task name").setRequired(true).setAutocomplete(true))
        .addStringOption(opt => opt.setName("params").setDescription("JSON parameters (optional)").setRequired(false)),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
            const tasks = await db.Task.findAll({
                where: {
                    name: {
                        [db.Sequelize.Op.like]: `%${focused}%`
                    },
                    enabled: true
                },
                limit: 25
            })

            await interaction.respond(
                tasks.map(t => ({
                    name: t.name,
                    value: t.name
                }))
            )
        } catch (err) {
            logger.error("❌ Task autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        const taskName = interaction.options.getString("name")
        const paramsStr = interaction.options.getString("params")

        await interaction.deferReply()

        try {
            // Find task
            const task = await db.Task.findOne({
                where: { name: taskName }
            })

            if (!task) {
                return interaction.editReply({
                    content: `❌ Task \`${taskName}\` not found.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Check if task is enabled
            if (!task.enabled) {
                return interaction.editReply({
                    content: `❌ Task \`${taskName}\` is disabled.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Check if agent is online
            if (!agents.isAgentOnline(task.agentId)) {
                return interaction.editReply({
                    content: `❌ Agent \`${task.agentId}\` is offline.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Use task.params as base, then merge with provided params if any
            let params = task.params || {}
            if (paramsStr) {
                try {
                    const overrideParams = JSON.parse(paramsStr)
                    if (typeof overrideParams !== "object" || Array.isArray(overrideParams)) {
                        throw new Error("Parameters must be a JSON object")
                    }
                    params = { ...params, ...overrideParams }
                } catch (err) {
                    logger.error(`❌ Parameter parsing failed:`, err)
                    return interaction.editReply({
                        content: "❌ Invalid JSON parameters format.",
                        flags: [MessageFlags.Ephemeral]
                    })
                }
            }

            // Run task
            const result = await taskManager.runTask(task.id, { params })

            if (!result) {
                logger.error(`❌ Task execution failed - no result returned`)
                return interaction.editReply({
                    content: `❌ Failed to start task: Task not found`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Initial status message
            const embed = createStatusEmbed(task, { status: "pending" })
            const message = await interaction.editReply({
                embeds: [embed],
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Danger)
                    )
                ]
            })

            // Set up cancel button collector
            const collector = message.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id,
                time: 300000 // 5 minutes
            })

            collector.on("collect", async i => {
                if (i.customId === "cancel") {
                    await i.deferUpdate()
                    const cancelled = await taskManager.cancelTask(task.id)
                    if (cancelled) {
                        clearInterval(updateInterval)
                        collector.stop()
                        const finalEmbed = createStatusEmbed(task, {
                            status: "cancelled",
                            stderr: "Task cancelled by user"
                        })
                        await i.editReply({
                            embeds: [finalEmbed],
                            components: []
                        })
                        logger.info(`🚫 Task successfully cancelled`)
                    } else {
                        logger.warn(`⚠️ Task cancellation failed`)
                        await i.editReply({
                            content: `❌ Could not cancel task \`${task.name}\`. It may have already completed.`,
                            components: []
                        })
                    }
                }
            })

            // Set up status updates
            const updateInterval = setInterval(async () => {
                try {
                    const run = await db.TaskRun.findOne({
                        where: { taskId: task.id },
                        order: [["createdAt", "DESC"]]
                    })

                    if (!run) {
                        logger.warn(`⚠️ No run record found for status update`)
                        return
                    }

                    const finalStates = ["success", "error", "cancelled"]
                    if (finalStates.includes(run.status)) {
                        logger.info(`✅ Task completed with status: ${run.status}`)
                        clearInterval(updateInterval)
                        collector.stop()

                        // Final status update
                        const finalEmbed = createStatusEmbed(task, {
                            status: run.status,
                            stdout: run.stdout,
                            stderr: run.stderr,
                            durationMs: run.durationMs
                        })

                        await interaction.editReply({
                            embeds: [finalEmbed],
                            components: []
                        })
                    } else {
                        // Update status for running task
                        logger.debug(`🔄 Updating running task status`)
                        const statusEmbed = createStatusEmbed(task, {
                            status: run.status,
                            stdout: run.stdout,
                            stderr: run.stderr
                        })
                        await interaction.editReply({
                            embeds: [statusEmbed]
                        })
                    }
                } catch (err) {
                    logger.error(`❌ Failed to update task status:`, err)
                }
            }, UPDATE_INTERVAL)

            // Clean up interval after timeout
            setTimeout(() => {
                clearInterval(updateInterval)
                collector.stop()
                logger.info(`⏱️ Status updates stopped due to timeout`)
            }, 300000) // 5 minutes timeout
        } catch (err) {
            logger.error("❌ Failed to run task:", err)
            return interaction.editReply({
                content: "❌ Failed to run task.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
