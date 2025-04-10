/**
 * Recent Logs Command
 * View recent task executions across all agents
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
        default:
            return { [db.Sequelize.Op.gte]: new Date(now - 60 * 60 * 1000) } // Default 1h
    }
}

/**
 * Create log entry embed
 * @param {Array} runs Task run records with task and agent info
 * @param {Object} options Display options
 * @returns {EmbedBuilder} Discord embed
 */
function createLogEmbed(runs, options) {
    const { page = 1, filter = "all", timeRange = "1h" } = options
    const start = (page - 1) * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, runs.length)
    const pageRuns = runs.slice(start, end)

    const embed = new EmbedBuilder()
        .setTitle("📜 Recent Task Executions")
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

        description += `**${run.Task.name}** on \`${run.Task.agentId}\`\n`
        description += `↳ ${status} ${run.status.toUpperCase()} | <t:${timestamp}:R> | Duration: ${formatDuration(run.durationMs)}\n`

        if (run.stderr?.trim()) {
            description += "```diff\n"
            description += run.stderr.slice(0, 200)
            if (run.stderr.length > 200) description += "\n... (truncated)"
            description += "\n```\n"
        } else if (run.stdout?.trim()) {
            description += "```\n"
            description += run.stdout.slice(0, 200)
            if (run.stdout.length > 200) description += "\n... (truncated)"
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
    const uniqueAgents = new Set(runs.map(r => r.Task.agentId)).size

    embed.addFields([
        {
            name: "Summary",
            value: [
                `Tasks: ${uniqueTasks}`,
                `Agents: ${uniqueAgents}`,
                `Total Runs: ${totalRuns}`,
                `Success Rate: ${totalRuns > 0 ? ((successRuns / totalRuns) * 100).toFixed(1) : 0}%`,
                `Page ${page}/${Math.ceil(runs.length / PAGE_SIZE)}`
            ].join(" | ")
        }
    ])

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("recent")
        .setDescription("View recent task executions")
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
                    { name: "Last Hour", value: "1h" },
                    { name: "Last 24 Hours", value: "24h" },
                    { name: "Last 7 Days", value: "7d" }
                )
        )
        .addStringOption(opt =>
            opt.setName("agent")
                .setDescription("Filter by agent ID")
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(opt =>
            opt.setName("task")
                .setDescription("Filter by task name")
                .setRequired(false)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        try {
            const { name, value: focused } = interaction.options.getFocused(true)

            if (name === "agent") {
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
            } else if (name === "task") {
                const tasks = await db.Task.findAll({
                    where: {
                        name: {
                            [db.Sequelize.Op.like]: `%${focused}%`
                        }
                    },
                    limit: 25
                })

                await interaction.respond(
                    tasks.map(t => ({
                        name: t.name,
                        value: t.name
                    }))
                )
            }
        } catch (err) {
            logger.error("❌ Autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        const status = interaction.options.getString("status") || "all"
        const timeRange = interaction.options.getString("time") || "1h"
        const agentId = interaction.options.getString("agent")
        const taskName = interaction.options.getString("task")

        await interaction.deferReply()

        try {
            // Build task query
            const taskWhere = {}
            if (agentId) taskWhere.agentId = agentId
            if (taskName) taskWhere.name = taskName

            // Build run query
            const runWhere = {
                createdAt: getTimeRangeCondition(timeRange)
            }
            if (status !== "all") {
                runWhere.status = status
            }

            // Fetch runs with task info
            const runs = await db.TaskRun.findAll({
                where: runWhere,
                include: [{
                    model: db.Task,
                    where: taskWhere,
                    attributes: ["name", "agentId"]
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
                            }
                        ])
                )

            components.push(filterRow, timeRow)

            // Send initial response
            const embed = createLogEmbed(runs, {
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

                        // Build new queries
                        const runWhere = {
                            createdAt: getTimeRangeCondition(currentTimeRange)
                        }
                        if (currentStatus !== "all") {
                            runWhere.status = currentStatus
                        }

                        // Fetch new filtered runs
                        currentRuns = await db.TaskRun.findAll({
                            where: runWhere,
                            include: [{
                                model: db.Task,
                                where: taskWhere,
                                attributes: ["name", "agentId"]
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
                    const newEmbed = createLogEmbed(currentRuns, {
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
            logger.error("❌ Failed to fetch recent logs:", err)
            return interaction.editReply({
                content: "❌ Failed to retrieve recent logs.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
