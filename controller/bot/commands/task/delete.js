/**
 * Task Delete Command
 * Handles task deletion with dependency cleanup
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

/**
 * Create confirmation embed for task deletion
 * @param {Object} task Task to delete
 * @param {Object} dependencies Dependency information
 * @returns {EmbedBuilder} Discord embed
 */
function createConfirmationEmbed(task, dependencies) {
    const embed = new EmbedBuilder()
        .setTitle(`🗑️ Delete Task: ${task.name}`)
        .setColor("#ff0000")
        .addFields([
            { name: "Type", value: task.type, inline: true },
            { name: "Agent", value: task.agentId, inline: true }
        ])

    if (task.schedule) {
        embed.addFields([{ name: "Schedule", value: task.schedule, inline: true }])
    }

    // Add dependency warnings
    if (dependencies.upstream.length > 0) {
        embed.addFields([
            {
                name: "⚠️ Tasks that depend on this",
                value: dependencies.upstream.map(t => `\`${t.name}\``).join(", ")
            }
        ])
    }

    if (dependencies.downstream.length > 0) {
        embed.addFields([
            {
                name: "⚠️ Dependencies that will be removed",
                value: dependencies.downstream.map(t => `\`${t.name}\``).join(", ")
            }
        ])
    }

    const scriptPreview = task.script.length > 200 ? task.script.substring(0, 200) + "..." : task.script

    embed.addFields([
        {
            name: "Script Preview",
            value: `\`\`\`${task.type}\n${scriptPreview}\n\`\`\``
        }
    ])

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("delete")
        .setDescription("Delete a task")
        .addStringOption(opt =>
            opt.setName("name").setDescription("Task name").setRequired(true).setAutocomplete(true)
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

            // Get dependencies
            const [upstreamDeps, downstreamDeps] = await Promise.all([
                // Tasks that depend on this one
                db.TaskDependency.findAll({
                    where: { parentTaskId: task.id },
                    include: [
                        {
                            model: db.Task,
                            as: "childTask"
                        }
                    ]
                }),
                // Tasks that this one depends on
                db.TaskDependency.findAll({
                    where: { childTaskId: task.id },
                    include: [
                        {
                            model: db.Task,
                            as: "parentTask"
                        }
                    ]
                })
            ])

            const dependencies = {
                upstream: upstreamDeps.map(d => d.childTask),
                downstream: downstreamDeps.map(d => d.parentTask)
            }

            // Show confirmation
            const embed = createConfirmationEmbed(task, dependencies)
            const buttons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("confirm").setLabel("Delete").setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId("cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
            )

            const message = await interaction.editReply({
                embeds: [embed],
                components: [buttons]
            })

            // Handle button interaction
            const collector = message.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id,
                time: 30000,
                max: 1
            })

            collector.on("collect", async i => {
                if (i.customId === "confirm") {
                    try {
                        // Delete dependencies
                        await db.TaskDependency.destroy({
                            where: {
                                [db.Sequelize.Op.or]: [{ parentTaskId: task.id }, { childTaskId: task.id }]
                            }
                        })

                        // Delete task runs
                        await db.TaskRun.destroy({
                            where: { taskId: task.id }
                        })

                        // Delete task
                        await task.destroy()

                        logger.info(`✅ Task deleted: ${taskName}`)

                        await i.update({
                            content: `✅ Task \`${taskName}\` has been deleted.`,
                            embeds: [],
                            components: []
                        })
                    } catch (err) {
                        logger.error(`❌ Failed to delete task ${taskName}:`, err)
                        await i.update({
                            content: "❌ Failed to delete task.",
                            embeds: [],
                            components: []
                        })
                    }
                } else {
                    await i.update({
                        content: "🚫 Task deletion cancelled.",
                        embeds: [],
                        components: []
                    })
                }
            })

            collector.on("end", collected => {
                if (collected.size === 0) {
                    interaction
                        .editReply({
                            content: "⏱️ Confirmation timed out.",
                            embeds: [],
                            components: []
                        })
                        .catch(() => {})
                }
            })
        } catch (err) {
            logger.error("❌ Failed to process delete command:", err)
            return interaction.editReply({
                content: "❌ Failed to process delete command.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
