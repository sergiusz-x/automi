/**
 * Agent Log Command
 * View execution logs for all tasks on an agent
 */
const { 
    SlashCommandSubcommandBuilder, 
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags 
} = require("discord.js")
const { DateTime } = require("luxon")
const logger = require("../../../utils/logger")
const db = require("../../../db")

// Page size for pagination
const PAGE_SIZE = 5

/**
 * Format duration in milliseconds
 * @param {number} ms Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(ms) {
    if (!ms) return "0ms"
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
}

/**
 * Get time range filter condition
 * @param {string} range Time range identifier
 * @returns {Object} Sequelize where condition
 */
function getTimeRangeCondition(range) {
    const now = new Date()
    switch (range) {
        case "1h":
            return { [db.Sequelize.Op.gte]: new Date(now - 60 * 60 * 1000) }
        case "24h":
            return { [db.Sequelize.Op.gte]: new Date(now - 24 * 60 * 60 * 1000) }
        case "7d":
            return { [db.Sequelize.Op.gte]: new Date(now - 7 * 24 * 60 * 60 * 1000) }
        case "30d":
            return { [db.Sequelize.Op.gte]: new Date(now - 30 * 24 * 60 * 60 * 1000) }
        default:
            return {}
    }
}

/**
 * Create log entry embed
 * @param {Array} runs Task run records with task info
 * @param {Object} agent Agent record
 * @param {Object} options Display options
 * @returns {EmbedBuilder} Discord embed
 */
function createLogEmbed(runs, agent, options) {
    const { page = 1, filter = "all", timeRange = "all" } = options
    const start = (page - 1) * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, runs.length)
    const pageRuns = runs.slice(start, end)

    const embed = new EmbedBuilder()
        .setTitle(`📜 Agent Logs: ${agent.agentId}`)
        .setColor(0x00bcd4)

    if (runs.length === 0) {
        embed.setDescription("No execution logs found matching the criteria.")
        return embed
    }

    // Add run entries
    let description = ""
    for (const run of pageRuns) {
        const status = {
            success: "✅",
            error: "❌",
            pending: "⏳"
        }[run.status] || "❓"

        // Convert to Unix timestamp (seconds)
        const timestamp = Math.floor(run.createdAt.getTime() / 1000)

        description += `**${run.Task.name}** (Run #${run.id})\n`
        description += `↳ ${status} Status: ${run.status.toUpperCase()} | Duration: ${formatDuration(run.durationMs)}\n`
        description += `↳ Time: <t:${timestamp}:f>\n`

        if (run.stdout?.trim()) {
            description += "```\n"
            description += run.stdout.slice(0, 200)
            if (run.stdout.length > 200) description += "\n... (truncated)"
            description += "\n```\n"
        }

        if (run.stderr?.trim()) {
            description += "```diff\n"
            description += run.stderr.slice(0, 200)
            if (run.stderr.length > 200) description += "\n... (truncated)"
            description += "\n```\n"
        }

        description += "\n"
    }

    embed.setDescription(description.trim())

    // Add summary field
    const totalRuns = runs.length
    const successRuns = runs.filter(r => r.status === "success").length
    const errorRuns = runs.filter(r => r.status === "error").length
    const uniqueTasks = new Set(runs.map(r => r.Task.name)).size

    embed.addFields([
        {
            name: "Summary",
            value: [
                `Tasks: ${uniqueTasks}`,
                `Total Runs: ${totalRuns}`,
                `Success: ${successRuns}`,
                `Error: ${errorRuns}`,
                `Page ${page}/${Math.ceil(runs.length / PAGE_SIZE)}`
            ].join(" | ")
        }
    ])

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("agent")
        .setDescription("View agent execution logs")
        .addStringOption(opt =>
            opt.setName("id")
                .setDescription("Agent ID")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(opt =>
            opt.setName("status")
                .setDescription("Filter by status")
                .setRequired(false)
                .addChoices(
                    { name: "All Runs", value: "all" },
                    { name: "Success Only", value: "success" },
                    { name: "Errors Only", value: "error" }
                )
        )
        .addStringOption(opt =>
            opt.setName("time")
                .setDescription("Time range")
                .setRequired(false)
                .addChoices(
                    { name: "All Time", value: "all" },
                    { name: "Last Hour", value: "1h" },
                    { name: "Last 24 Hours", value: "24h" },
                    { name: "Last 7 Days", value: "7d" },
                    { name: "Last 30 Days", value: "30d" }
                )
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
            const agents = await db.Agent.findAll({
                where: {
                    agentId: {
                        [db.Sequelize.Op.like]: `%${focused}%`
                    }
                },
                limit: 25
            })

            await interaction.respond(
                agents.map(a => ({
                    name: a.agentId,
                    value: a.agentId
                }))
            )
        } catch (err) {
            logger.error("❌ Agent autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        const agentId = interaction.options.getString("id")
        const status = interaction.options.getString("status") || "all"
        const timeRange = interaction.options.getString("time") || "all"

        await interaction.deferReply()

        try {
            // Find agent
            const agent = await db.Agent.findOne({
                where: { agentId }
            })

            if (!agent) {
                return interaction.editReply({
                    content: `❌ Agent \`${agentId}\` not found.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Get tasks for this agent
            const tasks = await db.Task.findAll({
                where: { agentId }
            })

            if (tasks.length === 0) {
                return interaction.editReply({
                    content: `❌ No tasks found for agent \`${agentId}\`.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Build query conditions
            const where = {
                taskId: tasks.map(t => t.id)
            }
            if (status !== "all") {
                where.status = status
            }
            if (timeRange !== "all") {
                where.createdAt = getTimeRangeCondition(timeRange)
            }

            // Fetch runs with task info
            const runs = await db.TaskRun.findAll({
                where,
                include: [{
                    model: db.Task,
                    attributes: ["name"]
                }],
                order: [["createdAt", "DESC"]],
                limit: 100
            })

            // Create pagination buttons if needed
            const totalPages = Math.ceil(runs.length / PAGE_SIZE)
            let components = []

            if (totalPages > 1) {
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId("prev")
                            .setLabel("Previous")
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(true),
                        new ButtonBuilder()
                            .setCustomId("next")
                            .setLabel("Next")
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(runs.length <= PAGE_SIZE)
                    )
                components.push(row)
            }

            // Add filter menus
            const filterRow = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("filter")
                        .setPlaceholder("Filter by status...")
                        .addOptions([
                            {
                                label: "All Runs",
                                value: "all",
                                default: status === "all"
                            },
                            {
                                label: "Success Only",
                                value: "success",
                                default: status === "success"
                            },
                            {
                                label: "Errors Only",
                                value: "error",
                                default: status === "error"
                            }
                        ])
                )

            const timeRow = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("time")
                        .setPlaceholder("Time range...")
                        .addOptions([
                            {
                                label: "All Time",
                                value: "all",
                                default: timeRange === "all"
                            },
                            {
                                label: "Last Hour",
                                value: "1h",
                                default: timeRange === "1h"
                            },
                            {
                                label: "Last 24 Hours",
                                value: "24h",
                                default: timeRange === "24h"
                            },
                            {
                                label: "Last 7 Days",
                                value: "7d",
                                default: timeRange === "7d"
                            },
                            {
                                label: "Last 30 Days",
                                value: "30d",
                                default: timeRange === "30d"
                            }
                        ])
                )

            components.push(filterRow, timeRow)

            // Send initial response
            const embed = createLogEmbed(runs, agent, { 
                page: 1, 
                filter: status,
                timeRange 
            })

            const message = await interaction.editReply({
                embeds: [embed],
                components
            })

            // Set up interaction collectors
            const collector = message.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id,
                time: 300000 // 5 minutes
            })

            let currentPage = 1
            let currentRuns = runs
            let currentStatus = status
            let currentTimeRange = timeRange

            collector.on("collect", async i => {
                try {
                    if (i.customId === "prev") {
                        currentPage--
                    } else if (i.customId === "next") {
                        currentPage++
                    } else if (i.customId === "filter" || i.customId === "time") {
                        if (i.customId === "filter") {
                            currentStatus = i.values[0]
                        } else {
                            currentTimeRange = i.values[0]
                        }

                        // Build new query
                        const where = {
                            taskId: tasks.map(t => t.id)
                        }
                        if (currentStatus !== "all") {
                            where.status = currentStatus
                        }
                        if (currentTimeRange !== "all") {
                            where.createdAt = getTimeRangeCondition(currentTimeRange)
                        }

                        // Fetch new filtered runs
                        currentRuns = await db.TaskRun.findAll({
                            where,
                            include: [{
                                model: db.Task,
                                attributes: ["name"]
                            }],
                            order: [["createdAt", "DESC"]],
                            limit: 100
                        })

                        currentPage = 1
                    }

                    // Update pagination buttons
                    const totalPages = Math.ceil(currentRuns.length / PAGE_SIZE)
                    if (components[0]) {
                        components[0].components[0].setDisabled(currentPage === 1)
                        components[0].components[1].setDisabled(currentPage === totalPages)
                    }

                    // Update embed
                    const newEmbed = createLogEmbed(currentRuns, agent, {
                        page: currentPage,
                        filter: currentStatus,
                        timeRange: currentTimeRange
                    })

                    await i.update({
                        embeds: [newEmbed],
                        components
                    })
                } catch (err) {
                    logger.error("❌ Failed to update logs:", err)
                    await i.update({
                        content: "❌ Failed to update logs.",
                        components: []
                    })
                }
            })

            collector.on("end", () => {
                interaction.editReply({
                    components: []
                }).catch(() => {})
            })

        } catch (err) {
            logger.error("❌ Failed to fetch agent logs:", err)
            return interaction.editReply({
                content: "❌ Failed to retrieve agent logs.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
