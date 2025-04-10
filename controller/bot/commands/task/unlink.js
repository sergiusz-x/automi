/**
 * Task Unlink Command
 * Removes dependencies between tasks
 */
const { SlashCommandSubcommandBuilder, MessageFlags } = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("unlink")
        .setDescription("Remove a dependency between two tasks")
        .addStringOption(opt =>
            opt.setName("parent")
                .setDescription("Parent task")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(opt =>
            opt.setName("child")
                .setDescription("Child task to remove from chain")
                .setRequired(true)
                .setAutocomplete(true)
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
            const focusedOption = interaction.options.getFocused(true)

            if (focusedOption.name === "parent") {
                // Find tasks that have dependencies
                const parentIds = await db.TaskDependency.findAll({
                    attributes: ["parentTaskId"],
                    group: ["parentTaskId"]
                })

                const tasks = await db.Task.findAll({
                    where: {
                        id: parentIds.map(d => d.parentTaskId),
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
            } else {
                // For child option, show only tasks that depend on the selected parent
                const parentName = interaction.options.getString("parent")
                if (!parentName) {
                    await interaction.respond([])
                    return
                }

                const parent = await db.Task.findOne({
                    where: { name: parentName }
                })

                if (!parent) {
                    await interaction.respond([])
                    return
                }

                const dependencies = await db.TaskDependency.findAll({
                    where: { parentTaskId: parent.id }
                })

                const childTasks = await db.Task.findAll({
                    where: {
                        id: dependencies.map(d => d.childTaskId),
                        name: {
                            [db.Sequelize.Op.like]: `%${focused}%`
                        }
                    },
                    limit: 25
                })

                await interaction.respond(
                    childTasks.map(t => ({
                        name: t.name,
                        value: t.name
                    }))
                )
            }
        } catch (err) {
            logger.error("❌ Task autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        const parentName = interaction.options.getString("parent")
        const childName = interaction.options.getString("child")

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

        try {
            // Find both tasks
            const [parent, child] = await Promise.all([
                db.Task.findOne({ where: { name: parentName } }),
                db.Task.findOne({ where: { name: childName } })
            ])

            // Validate tasks exist
            if (!parent || !child) {
                return interaction.editReply({
                    content: "❌ One or both tasks not found.",
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Find and remove dependency
            const dependency = await db.TaskDependency.findOne({
                where: {
                    parentTaskId: parent.id,
                    childTaskId: child.id
                }
            })

            if (!dependency) {
                return interaction.editReply({
                    content: `❌ Task \`${childName}\` does not depend on \`${parentName}\`.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Capture condition before destroying for logging purposes
            const condition = dependency.condition || 'always'
            
            await dependency.destroy()
            logger.info(`✅ Removed task dependency: ${parentName} → ${childName} (${condition})`)

            // Customize message based on previous condition
            let message = `✅ Dependency removed. Task \`${childName}\` no longer depends on \`${parentName}\``;
            
            if (condition === "on:success") {
                message += " for successful completions";
            } else if (condition === "on:error") {
                message += " for error outcomes";
            }
            
            message += ".";

            return interaction.editReply({
                content: message,
                flags: [MessageFlags.Ephemeral]
            })

        } catch (err) {
            logger.error("❌ Failed to remove task dependency:", err)
            return interaction.editReply({
                content: "❌ Failed to remove task dependency.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
