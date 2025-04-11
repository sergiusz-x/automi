/**
 * Agent Info Command
 * Shows detailed agent information and statistics
 */
const { SlashCommandSubcommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")
const agents = require("../../../core/agents")

/**
 * Calculate task statistics for an agent
 * @param {string} agentId Agent ID
 * @returns {Promise<Object>} Statistics object
 */
async function calculateTaskStats(agentId) {
    // Get tasks assigned to this agent
    const tasks = await db.Task.findAll({
        where: { agentId }
    })

    if (tasks.length === 0) {
        return {
            totalTasks: 0,
            enabledTasks: 0,
            scheduledTasks: 0,
            runs: {
                total: 0,
                success: 0,
                error: 0,
                last24h: 0
            }
        }
    }

    const taskIds = tasks.map(t => t.id)

    // Get task runs for the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [totalRuns, successRuns, errorRuns, recent] = await Promise.all([
        db.TaskRun.count({ where: { taskId: taskIds } }),
        db.TaskRun.count({ where: { taskId: taskIds, status: "success" } }),
        db.TaskRun.count({ where: { taskId: taskIds, status: "error" } }),
        db.TaskRun.count({
            where: {
                taskId: taskIds,
                createdAt: { [db.Sequelize.Op.gte]: oneDayAgo }
            }
        })
    ])

    return {
        totalTasks: tasks.length,
        enabledTasks: tasks.filter(t => t.enabled).length,
        scheduledTasks: tasks.filter(t => t.schedule).length,
        runs: {
            total: totalRuns,
            success: successRuns,
            error: errorRuns,
            last24h: recent
        }
    }
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("info")
        .setDescription("Show detailed agent information")
        .addStringOption(opt => opt.setName("id").setDescription("Agent ID").setRequired(true).setAutocomplete(true)),

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

            const isOnline = agents.isAgentOnline(agentId)
            const stats = await calculateTaskStats(agentId)

            // Create embed
            const embed = new EmbedBuilder().setTitle(`🤖 Agent: ${agentId}`).setColor(isOnline ? "#00ff00" : "#ff0000")

            // Status section
            const statusEmoji = isOnline ? "🟢" : "🔴"
            embed.addFields([
                {
                    name: "Status",
                    value: [
                        `${statusEmoji} ${isOnline ? "Online" : "Offline"}`,
                        `Last Seen: ${
                            agent.lastSeen ? `<t:${Math.floor(agent.lastSeen.getTime() / 1000)}:R>` : "Never"
                        }`
                    ].join("\n"),
                    inline: true
                }
            ])

            // IP information
            if (Array.isArray(agent.ipWhitelist) && agent.ipWhitelist.length > 0) {
                embed.addFields([
                    {
                        name: "IP Whitelist",
                        value: agent.ipWhitelist.join("\n"),
                        inline: true
                    }
                ])
            }

            // Task statistics
            const successRate = stats.runs.total > 0 ? ((stats.runs.success / stats.runs.total) * 100).toFixed(1) : 0

            embed.addFields([
                {
                    name: "Tasks",
                    value: [
                        `Total: ${stats.totalTasks}`,
                        `Enabled: ${stats.enabledTasks}`,
                        `Scheduled: ${stats.scheduledTasks}`
                    ].join("\n"),
                    inline: true
                },
                {
                    name: "Executions",
                    value: [
                        `Total: ${stats.runs.total}`,
                        `Success Rate: ${successRate}%`,
                        `Last 24h: ${stats.runs.last24h}`
                    ].join("\n"),
                    inline: true
                }
            ])

            return interaction.editReply({ embeds: [embed] })
        } catch (err) {
            logger.error("❌ Failed to get agent info:", err)
            return interaction.editReply({
                content: "❌ Failed to retrieve agent information.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
