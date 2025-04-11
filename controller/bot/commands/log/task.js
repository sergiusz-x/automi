/**
 * Task Log Command
 * View and filter task execution logs
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
 * Create log entry embed
 * @param {Array} runs Task run records
 * @param {Object} task Task record
 * @param {Object} options Display options
 * @returns {EmbedBuilder} Discord embed
 */
function createLogEmbed(runs, task, options) {
    const { page = 1, filter = "all" } = options
    const start = (page - 1) * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, runs.length)
    const pageRuns = runs.slice(start, end)

    const embed = new EmbedBuilder().setTitle(`📜 Task Logs: ${task.name}`).setColor("#00bcd4")

    if (runs.length === 0) {
        embed.setDescription("No execution logs found matching the criteria.")
        return embed
    }

    // Add run entries
    let description = ""
    for (const run of pageRuns) {
        const status =
            {
                success: "✅",
                error: "❌",
                pending: "⏳"
            }[run.status] || "❓"

        // Convert to Unix timestamp (seconds)
        const timestamp = Math.floor(run.createdAt.getTime() / 1000)

        description += `**Run #${run.id}** (<t:${timestamp}:f>)\n`
        description += `↳ ${status} Status: ${run.status.toUpperCase()} | Duration: ${formatDuration(run.durationMs)}\n`

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

    embed.addFields([
        {
            name: "Summary",
            value: [
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
        .setName("task")
        .setDescription("View task execution logs")
        .addStringOption(opt => opt.setName("name").setDescription("Task name").setRequired(true).setAutocomplete(true))
        .addStringOption(opt =>
            opt
                .setName("status")
                .setDescription("Filter by status")
                .setRequired(false)
                .addChoices(
                    { name: "All Runs", value: "all" },
                    { name: "Success Only", value: "success" },
                    { name: "Errors Only", value: "error" }
                )
        )
        .addIntegerOption(opt =>
            opt
                .setName("limit")
                .setDescription("Number of runs to fetch (default: 50)")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(100)
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
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
        } catch (err) {
            logger.error("❌ Task autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        const taskName = interaction.options.getString("name")
        const status = interaction.options.getString("status") || "all"
        const limit = interaction.options.getInteger("limit") || 50

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

            // Build query conditions
            const where = { taskId: task.id }
            if (status !== "all") {
                where.status = status
            }

            // Fetch runs
            const runs = await db.TaskRun.findAll({
                where,
                order: [["createdAt", "DESC"]],
                limit
            })

            // Create pagination buttons if needed
            const totalPages = Math.ceil(runs.length / PAGE_SIZE)
            let components = []

            if (totalPages > 1) {
                const row = new ActionRowBuilder().addComponents(
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

            // Add filter menu
            const filterRow = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId("filter")
                    .setPlaceholder("Filter logs...")
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
            components.push(filterRow)

            // Send initial response
            const embed = createLogEmbed(runs, task, { page: 1, filter: status })
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

            collector.on("collect", async i => {
                try {
                    if (i.customId === "prev") {
                        currentPage--
                    } else if (i.customId === "next") {
                        currentPage++
                    } else if (i.customId === "filter") {
                        const newStatus = i.values[0]

                        // Fetch new filtered runs
                        const where = { taskId: task.id }
                        if (newStatus !== "all") {
                            where.status = newStatus
                        }

                        currentRuns = await db.TaskRun.findAll({
                            where,
                            order: [["createdAt", "DESC"]],
                            limit
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
                    const newEmbed = createLogEmbed(currentRuns, task, {
                        page: currentPage,
                        filter: i.customId === "filter" ? i.values[0] : status
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
                interaction
                    .editReply({
                        components: []
                    })
                    .catch(() => {})
            })
        } catch (err) {
            logger.error("❌ Failed to fetch task logs:", err)
            return interaction.editReply({
                content: "❌ Failed to retrieve task logs.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
