const { 
    SlashCommandSubcommandBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder,
    MessageFlags
} = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")
const cron = require("node-cron")

const SCRIPT_PREVIEW_LENGTH = 1500

/**
 * Validate cron schedule expression
 * @param {string} schedule - Cron expression to validate
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateSchedule(schedule) {
    if (!schedule) return null // Optional field
    if (!cron.validate(schedule)) {
        return "Invalid cron schedule expression"
    }
    return null
}

/**
 * Generate script preview with syntax highlighting
 * @param {string} script - Script content
 * @param {string} type - Script type
 * @returns {string} Script preview with syntax highlighting
 */
function generateScriptPreview(script, type) {
    if (!script) return "No script content"
    
    const preview = script.length > SCRIPT_PREVIEW_LENGTH
        ? script.substring(0, SCRIPT_PREVIEW_LENGTH) + "\n... (truncated)"
        : script

    return `\`\`\`${type}\n${preview}\n\`\`\``
}

/**
 * Generate task preview embed
 * @param {Object} task - Task database record
 * @returns {EmbedBuilder} Discord embed
 */
function createTaskPreview(task) {
    const embed = new EmbedBuilder()
        .setTitle(`Task Preview: ${task.name}`)
        .setDescription(generateScriptPreview(task.script, task.type))
        .setColor(task.enabled ? 0x00ff00 : 0xff0000)
        .addFields([
            { name: "Type", value: task.type, inline: true },
            { name: "Agent", value: task.agentId, inline: true },
            { name: "Status", value: task.enabled ? "🟢 Enabled" : "🔴 Disabled", inline: true }
        ])

    if (task.schedule) {
        embed.addFields([
            { name: "Schedule", value: `\`${task.schedule}\``, inline: true }
        ])
    }

    if (task.params && Object.keys(task.params).length > 0) {
        embed.addFields([
            {
                name: "Parameters",
                value: `\`\`\`json\n${JSON.stringify(task.params, null, 2)}\n\`\`\``
            }
        ])
    }

    return embed
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("edit")
        .setDescription("Edit task configuration")
        .addStringOption(option => 
            option.setName("name")
                .setDescription("Name of the task to edit")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addStringOption(option =>
            option.setName("schedule")
                .setDescription("Cron schedule expression (optional)")
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName("enabled")
                .setDescription("Enable or disable the task")
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName("preview")
                .setDescription("Show current task configuration without editing")
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName("edit-script")
                .setDescription("Open script editor")
                .setRequired(false)
        )
        .addAttachmentOption(option =>
            option.setName("script-file")
                .setDescription("Upload a file containing the new script")
                .setRequired(false)
        ),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused()
            const tasks = await db.Task.findAll({
                attributes: ["name"],
                where: {
                    name: {
                        [db.Sequelize.Op.like]: `%${focused}%`
                    }
                },
                limit: 25
            })

            await interaction.respond(
                tasks.map(task => ({
                    name: task.name,
                    value: task.name
                }))
            )
        } catch (err) {
            logger.error("❌ Task autocomplete error:", err)
            await interaction.respond([])
        }
    },

    async execute(interaction) {
        const taskName = interaction.options.getString("name")
        const schedule = interaction.options.getString("schedule")
        const enabled = interaction.options.getBoolean("enabled")
        const editScript = interaction.options.getBoolean("edit-script")
        const previewOnly = interaction.options.getBoolean("preview")
        const scriptFile = interaction.options.getAttachment("script-file")

        try {
            // Find task first
            const task = await db.Task.findOne({ where: { name: taskName } })
            if (!task) {
                await interaction.reply({
                    content: `❌ Task \`${taskName}\` not found.`,
                    flags: [MessageFlags.Ephemeral]
                })
                return
            }

            // Handle script edit via modal before deferring reply
            if (editScript) {
                const modal = new ModalBuilder()
                    .setCustomId(`edit-task-${taskName}`)
                    .setTitle(`Edit Task: ${taskName}`)

                const scriptInput = new TextInputBuilder()
                    .setCustomId("script")
                    .setLabel(`${task.type.charAt(0).toUpperCase() + task.type.slice(1)} Script`)
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(task.script)
                    .setRequired(true)

                const row = new ActionRowBuilder().addComponents(scriptInput)
                modal.addComponents(row)

                await interaction.showModal(modal)
                return
            }

            // For all other operations, defer reply
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

            // If preview requested, just show current configuration
            if (previewOnly) {
                return interaction.editReply({
                    embeds: [createTaskPreview(task)],
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Handle script file upload
            if (scriptFile) {
                if (scriptFile.size > 1024 * 1024) { // 1MB limit
                    return interaction.editReply({
                        content: "❌ Script file too large. Maximum size is 1MB.",
                        flags: [MessageFlags.Ephemeral]
                    })
                }

                try {
                    const response = await fetch(scriptFile.url)
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
                    const newScript = await response.text()
                    
                    await task.update({ script: newScript })
                    logger.info(`✅ Task "${taskName}" script updated from file: ${scriptFile.name}`)

                    return interaction.editReply({
                        content: "✅ Task script updated from file successfully",
                        embeds: [createTaskPreview(await task.reload())],
                        flags: [MessageFlags.Ephemeral]
                    })
                } catch (err) {
                    logger.error(`❌ Failed to read script file: ${err}`)
                    return interaction.editReply({
                        content: "❌ Failed to read script file.",
                        flags: [MessageFlags.Ephemeral]
                    })
                }
            }

            // Validate schedule if provided
            if (schedule !== null) {
                const scheduleError = validateSchedule(schedule)
                if (scheduleError) {
                    return interaction.editReply({
                        content: `❌ ${scheduleError}`,
                        flags: [MessageFlags.Ephemeral]
                    })
                }
            }

            // Update task
            const updates = {}
            if (schedule !== null) updates.schedule = schedule
            if (enabled !== null) updates.enabled = enabled

            await task.update(updates)
            logger.info(`✅ Task "${taskName}" updated:`, updates)

            // Send preview
            await interaction.editReply({
                content: "✅ Task updated successfully",
                embeds: [createTaskPreview(await task.reload())],
                flags: [MessageFlags.Ephemeral]
            })

        } catch (err) {
            logger.error(`❌ Failed to edit task ${taskName}:`, err)
            if (!interaction.deferred && !interaction.replied) {
                await interaction.reply({
                    content: "❌ Failed to edit task.",
                    flags: [MessageFlags.Ephemeral]
                })
            } else {
                await interaction.editReply({
                    content: "❌ Failed to edit task.",
                    flags: [MessageFlags.Ephemeral]
                })
            }
        }
    }
}
