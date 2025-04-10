/**
 * Task List Command
 * Displays task list with filtering and sorting options
 */
const { 
    SlashCommandSubcommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")
const agents = require("../../../core/agents")

/**
 * Pages size for task list pagination
 */
const PAGE_SIZE = 10

/**
 * Format task schedule for display
 * @param {string} schedule Cron expression
 * @returns {string} Formatted schedule
 */
function formatSchedule(schedule) {
    if (!schedule) return "Manual trigger only"
    return `\`${schedule}\``
}

/**
 * Format task status with emoji
 * @param {boolean} enabled Task enabled state
 * @param {string} agentId Task's agent ID
 * @returns {string} Formatted status
 */
function formatStatus(enabled, agentId) {
    const agentOnline = agents.isAgentOnline(agentId)
    if (!enabled) return "🔴 Disabled"
    return agentOnline ? "🟢 Ready" : "🟡 Agent Offline"
}

/**
 * Create task list embed
 * @param {Array} tasks Task records
 * @param {Object} options Display options
 * @returns {EmbedBuilder} Discord embed
 */
function createTaskListEmbed(tasks, options) {
    const { page = 1, filter = "all" } = options

    const embed = new EmbedBuilder()
        .setTitle("📋 Task List")
        .setColor(0x00bcd4)

    if (tasks.length === 0) {
        embed.setDescription("No tasks found matching the criteria.")
        return embed
    }

    const start = (page - 1) * PAGE_SIZE
    const end = start + PAGE_SIZE
    const pageItems = tasks.slice(start, end)

    let description = ""
    for (const task of pageItems) {
        const status = formatStatus(task.enabled, task.agentId)
        description += `**${task.name}** (${task.type})\n`
        description += `↳ ${status} | ${formatSchedule(task.schedule)}\n`
    }

    embed.setDescription(description)

    // Add summary field
    embed.addFields([
        {
            name: "Summary",
            value: [
                `Total Tasks: ${tasks.length}`,
                `Enabled: ${tasks.filter(t => t.enabled).length}`,
                `Scheduled: ${tasks.filter(t => t.schedule).length}`,
                `Page ${page}/${Math.ceil(tasks.length / PAGE_SIZE)}`
            ].join(" | ")
        }
    ])

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("list")
        .setDescription("List all tasks")
        .addStringOption(option =>
            option.setName("filter")
                .setDescription("Filter tasks by status")
                .setRequired(false)
                .addChoices(
                    { name: "All Tasks", value: "all" },
                    { name: "Enabled Only", value: "enabled" },
                    { name: "Disabled Only", value: "disabled" },
                    { name: "Scheduled Only", value: "scheduled" }
                )
        )
        .addStringOption(option =>
            option.setName("agent")
                .setDescription("Filter by agent ID")
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option.setName("search")
                .setDescription("Search task names")
                .setRequired(false)
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
            const agents = await db.Agent.findAll({
                attributes: ["agentId"],
                where: {
                    agentId: {
                        [db.Sequelize.Op.like]: `%${focused}%`
                    }
                },
                limit: 25
            })

            await interaction.respond(
                agents.map(agent => ({
                    name: agent.agentId,
                    value: agent.agentId
                }))
            )
        } catch (err) {
            logger.error("❌ Agent autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        await interaction.deferReply()

        try {
            const filter = interaction.options.getString("filter") || "all"
            const agentId = interaction.options.getString("agent")
            const search = interaction.options.getString("search")

            // Build query conditions
            const where = {}
            if (filter === "enabled") where.enabled = true
            if (filter === "disabled") where.enabled = false
            if (filter === "scheduled") where.schedule = { [db.Sequelize.Op.ne]: null }
            if (agentId) where.agentId = agentId
            if (search) where.name = { [db.Sequelize.Op.like]: `%${search}%` }

            // Fetch tasks
            const tasks = await db.Task.findAll({
                where,
                order: [["name", "ASC"]]
            })

            // Create pagination buttons if needed
            const totalPages = Math.ceil(tasks.length / PAGE_SIZE)
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
                            .setDisabled(tasks.length <= PAGE_SIZE)
                    )
                components = [row]
            }

            // Send initial response
            const embed = createTaskListEmbed(tasks, { page: 1, filter })
            await interaction.editReply({
                embeds: [embed],
                components
            })

            if (components.length > 0) {
                // Set up pagination collector
                const collector = interaction.channel.createMessageComponentCollector({
                    filter: i => i.user.id === interaction.user.id,
                    time: 300000 // 5 minutes
                })

                let currentPage = 1

                collector.on("collect", async i => {
                    if (i.customId === "prev") currentPage--
                    if (i.customId === "next") currentPage++

                    // Update button states
                    const row = ActionRowBuilder.from(i.message.components[0])
                    row.components[0].setDisabled(currentPage === 1)
                    row.components[1].setDisabled(currentPage === totalPages)

                    // Update embed
                    const newEmbed = createTaskListEmbed(tasks, { 
                        page: currentPage,
                        filter
                    })

                    await i.update({
                        embeds: [newEmbed],
                        components: [row]
                    })
                })

                collector.on("end", () => {
                    interaction.editReply({
                        components: []
                    }).catch(() => {})
                })
            }

        } catch (err) {
            logger.error("❌ Failed to list tasks:", err)
            await interaction.editReply({
                content: "❌ Failed to retrieve task list.",
                embeds: [],
                components: []
            })
        }
    }
}
