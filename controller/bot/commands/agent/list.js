/**
 * Agent List Command
 * Displays agent list with status and task information
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

// Page size for pagination
const PAGE_SIZE = 5

/**
 * Format agent status with emoji
 * @param {string} status Status value
 * @param {boolean} isOnline Current connection state
 * @returns {string} Formatted status
 */
function formatStatus(status, isOnline) {
    const statusEmoji =
        {
            online: "🟢",
            offline: "🔴",
            error: "⚠️"
        }[status] || "❓"

    return `${statusEmoji} ${isOnline ? "Connected" : status.toUpperCase()}`
}

/**
 * Create agent list embed
 * @param {Array} agentList Agent records
 * @param {Object} options Display options
 * @returns {EmbedBuilder} Discord embed
 */
function createListEmbed(agentList, options) {
    const { page = 1, filter = "all" } = options
    const start = (page - 1) * PAGE_SIZE
    const end = Math.min(start + PAGE_SIZE, agentList.length)
    const pageAgents = agentList.slice(start, end)

    const embed = new EmbedBuilder().setTitle("🤖 Agent List").setColor("#00bcd4")

    if (agentList.length === 0) {
        embed.setDescription("No agents found matching the criteria.")
        return embed
    }

    // Add agent entries
    let description = ""
    for (const agent of pageAgents) {
        const isOnline = agents.isAgentOnline(agent.agentId)
        const status = formatStatus(agent.status, isOnline)
        const timestamp = agent.lastSeen ? Math.floor(agent.lastSeen.getTime() / 1000) : null
        const lastSeen = timestamp ? `<t:${timestamp}:R>` : "Never"

        description += `**${agent.agentId}**\n`
        description += `↳ ${status} | Last seen: ${lastSeen}\n`

        if (Array.isArray(agent.ipWhitelist) && agent.ipWhitelist.length > 0) {
            description += `↳ IP: ${agent.ipWhitelist.join(", ")}\n`
        }

        description += "\n"
    }

    embed.setDescription(description)

    // Add summary field
    const totalOnline = agentList.filter(a => agents.isAgentOnline(a.agentId)).length
    embed.addFields([
        {
            name: "Summary",
            value: [
                `Total Agents: ${agentList.length}`,
                `Online: ${totalOnline}`,
                `Page ${page}/${Math.ceil(agentList.length / PAGE_SIZE)}`
            ].join(" | ")
        }
    ])

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("list")
        .setDescription("List registered agents")
        .addStringOption(opt =>
            opt
                .setName("filter")
                .setDescription("Filter agents by status")
                .setRequired(false)
                .addChoices(
                    { name: "All Agents", value: "all" },
                    { name: "Online Only", value: "online" },
                    { name: "Offline Only", value: "offline" }
                )
        )
        .addStringOption(opt => opt.setName("search").setDescription("Search agent IDs").setRequired(false)),

    async execute(interaction) {
        await interaction.deferReply()

        try {
            const filter = interaction.options.getString("filter") || "all"
            const search = interaction.options.getString("search")

            // Build query conditions
            const where = {}
            if (search) {
                where.agentId = {
                    [db.Sequelize.Op.like]: `%${search}%`
                }
            }

            // Fetch agents
            let agentList = await db.Agent.findAll({
                where,
                order: [["agentId", "ASC"]]
            })

            // Apply online/offline filter
            if (filter === "online") {
                agentList = agentList.filter(a => agents.isAgentOnline(a.agentId))
            } else if (filter === "offline") {
                agentList = agentList.filter(a => !agents.isAgentOnline(a.agentId))
            }

            // Create pagination buttons if needed
            const totalPages = Math.ceil(agentList.length / PAGE_SIZE)
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
                        .setDisabled(agentList.length <= PAGE_SIZE)
                )
                components = [row]
            }

            // Send initial response
            const embed = createListEmbed(agentList, { page: 1, filter })
            const message = await interaction.editReply({
                embeds: [embed],
                components
            })

            if (components.length > 0) {
                // Set up pagination collector
                const collector = message.createMessageComponentCollector({
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
                    const newEmbed = createListEmbed(agentList, {
                        page: currentPage,
                        filter
                    })

                    await i.update({
                        embeds: [newEmbed],
                        components: [row]
                    })
                })

                collector.on("end", () => {
                    interaction
                        .editReply({
                            components: []
                        })
                        .catch(() => {})
                })
            }
        } catch (err) {
            logger.error("❌ Failed to list agents:", err)
            return interaction.editReply({
                content: "❌ Failed to retrieve agent list.",
                embeds: [],
                components: []
            })
        }
    }
}
