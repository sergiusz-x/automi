const {
    SlashCommandSubcommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags,
    EmbedBuilder
} = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")
const agents = require("../../../core/agents")

/**
 * Create current configuration embed
 * @param {Object} agent Agent record
 * @returns {EmbedBuilder} Discord embed
 */
function createConfigEmbed(agent) {
    const isOnline = agents.isAgentOnline(agent.agentId)
    const statusEmoji = isOnline ? "🟢" : "🔴"
    const lastSeen = agent.lastSeen ? `<t:${Math.floor(agent.lastSeen.getTime() / 1000)}:R>` : "Never"

    return new EmbedBuilder()
        .setTitle(`🔒 Edit IP Whitelist: ${agent.agentId}`)
        .setColor("#00bcd4")
        .addFields([
            {
                name: "Status",
                value: `${statusEmoji} ${isOnline ? "Online" : "Offline"}`,
                inline: true
            },
            {
                name: "Last Seen",
                value: lastSeen,
                inline: true
            },
            {
                name: "Current IP Whitelist",
                value:
                    Array.isArray(agent.ipWhitelist) && agent.ipWhitelist.length > 0
                        ? `\`${agent.ipWhitelist.join(", ")}\``
                        : "*No restrictions*"
            }
        ])
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("edit")
        .setDescription("Edit agent IP whitelist")
        .addStringOption(opt => opt.setName("id").setDescription("Agent ID").setRequired(true).setAutocomplete(true)),

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

        try {
            // Find agent
            const agent = await db.Agent.findOne({
                where: { agentId }
            })

            if (!agent) {
                return interaction.reply({
                    content: `❌ Agent \`${agentId}\` not found.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            const isOnline = agents.isAgentOnline(agent.agentId)

            // Parse IP whitelist from JSON if needed
            const currentIps = Array.isArray(agent.ipWhitelist)
                ? agent.ipWhitelist
                : JSON.parse(agent.ipWhitelist || '["*"]')

            // Create modal with embed data in customId
            const modal = new ModalBuilder()
                .setCustomId(`edit-agent-ip|${agentId}`)
                .setTitle(`Edit IP Whitelist: ${agentId}`)

            const ipInput = new TextInputBuilder()
                .setCustomId("ipWhitelist")
                .setLabel("IP Addresses (comma-separated, * for any)")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(currentIps.join(", "))
                .setPlaceholder("Example: 192.168.1.100 or *")
                .setRequired(true)

            const row = new ActionRowBuilder().addComponents(ipInput)
            modal.addComponents(row)

            // Show modal - the embed will be shown after modal submission
            await interaction.showModal(modal)
        } catch (err) {
            logger.error("❌ Failed to show edit modal:", err)
            return interaction.reply({
                content: "❌ Failed to load agent configuration.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
