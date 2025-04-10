/**
 * Task Link Command
 * Creates dependencies between tasks for chained execution
 */
const { SlashCommandSubcommandBuilder, MessageFlags } = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("link")
        .setDescription("Link one task to run after another")
        .addStringOption(opt =>
            opt.setName("parent")
                .setDescription("Parent task (runs first)")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(opt =>
            opt.setName("child")
                .setDescription("Child task (runs after parent)")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(opt =>
            opt.setName("condition")
                .setDescription("When the child task should run")
                .setRequired(false)
                .addChoices(
                    { name: "Always (default)", value: "always" },
                    { name: "Only on success", value: "on:success" },
                    { name: "Only on error", value: "on:error" }
                )
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
            const focusedOption = interaction.options.getFocused(true)

            // For child task, exclude the parent task from suggestions
            let exclude = []
            if (focusedOption.name === "child") {
                const parentName = interaction.options.getString("parent")
                if (parentName) exclude.push(parentName)
            }

            const tasks = await db.Task.findAll({
                where: {
                    name: {
                        [db.Sequelize.Op.like]: `%${focused}%`,
                        [db.Sequelize.Op.notIn]: exclude
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
        const parentName = interaction.options.getString("parent")
        const childName = interaction.options.getString("child")
        const condition = interaction.options.getString("condition") || "always"

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

        try {
            // Check for self-dependency
            if (parentName === childName) {
                return interaction.editReply({
                    content: "❌ A task cannot depend on itself.",
                    flags: [MessageFlags.Ephemeral]
                })
            }

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

            // Check for existing dependency
            const existing = await db.TaskDependency.findOne({
                where: {
                    parentTaskId: parent.id,
                    childTaskId: child.id
                }
            })

            if (existing) {
                return interaction.editReply({
                    content: `❌ Task \`${childName}\` already depends on \`${parentName}\`.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Check for circular dependencies
            const dependencies = await db.TaskDependency.findAll()
            const graph = new Map()
            
            for (const dep of dependencies) {
                if (!graph.has(dep.parentTaskId)) {
                    graph.set(dep.parentTaskId, new Set())
                }
                graph.get(dep.parentTaskId).add(dep.childTaskId)
            }

            // Add proposed dependency
            if (!graph.has(parent.id)) {
                graph.set(parent.id, new Set())
            }
            graph.get(parent.id).add(child.id)

            // Check for cycles using DFS
            const visited = new Set()
            const recursionStack = new Set()

            function hasCycle(taskId) {
                visited.add(taskId)
                recursionStack.add(taskId)

                const deps = graph.get(taskId) || new Set()
                for (const depId of deps) {
                    if (!visited.has(depId)) {
                        if (hasCycle(depId)) {
                            return true
                        }
                    } else if (recursionStack.has(depId)) {
                        return true
                    }
                }

                recursionStack.delete(taskId)
                return false
            }

            if (hasCycle(parent.id)) {
                return interaction.editReply({
                    content: "❌ This dependency would create a circular chain.",
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Create dependency
            await db.TaskDependency.create({
                parentTaskId: parent.id,
                childTaskId: child.id,
                condition: condition
            })

            logger.info(`✅ Created task dependency: ${parentName} → ${childName} (${condition})`)

            // Customize message based on condition
            let message = `✅ Task \`${childName}\` will now run after \`${parentName}\``;
            if (condition === "on:success") {
                message += " completes successfully.";
            } else if (condition === "on:error") {
                message += " fails with an error.";
            } else {
                message += " completes (regardless of outcome).";
            }

            return interaction.editReply({
                content: message,
                flags: [MessageFlags.Ephemeral]
            })

        } catch (err) {
            logger.error("❌ Failed to create task dependency:", err)
            return interaction.editReply({
                content: "❌ Failed to create task dependency.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
