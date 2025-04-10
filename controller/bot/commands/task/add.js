/**
 * Task Add Command
 * Creates new automation tasks with validation
 */
const { 
    SlashCommandSubcommandBuilder, 
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    MessageFlags,
    AttachmentBuilder
} = require("discord.js")
const logger = require("../../../utils/logger")
const db = require("../../../db")
const cron = require("node-cron")
const fs = require('fs').promises

/**
 * Validate task name format
 * @param {string} name Task name to validate
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateTaskName(name) {
    if (!name || name.length < 3 || name.length > 50) {
        return "Task name must be between 3 and 50 characters"
    }
    if (!/^[a-zA-Z0-9-_]+$/.test(name)) {
        return "Task name can only contain letters, numbers, hyphens, and underscores"
    }
    return null
}

/**
 * Validate cron schedule expression
 * @param {string} schedule Cron expression to validate
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateSchedule(schedule) {
    if (!schedule) return null // Optional field
    if (!cron.validate(schedule)) {
        return "Invalid cron schedule expression"
    }
    return null
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("add")
        .setDescription("Create a new task")
        .addStringOption(opt =>
            opt.setName("name")
                .setDescription("Task name (letters, numbers, hyphens, underscores)")
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName("type")
                .setDescription("Script type")
                .setRequired(true)
                .addChoices(
                    { name: "Bash Script", value: "bash" },
                    { name: "Python Script", value: "python" },
                    { name: "Node.js Script", value: "node" }
                )
        )
        .addStringOption(opt =>
            opt.setName("agent")
                .setDescription("Agent to run the task")
                .setRequired(true)
                .setAutocomplete(true)
        )
        .addAttachmentOption(opt =>
            opt.setName("script_file")
                .setDescription("Script file to upload (optional)")
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName("schedule")
                .setDescription("Cron schedule (optional)")
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName("params")
                .setDescription("JSON parameters (optional)")
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
        const name = interaction.options.getString("name")
        const type = interaction.options.getString("type")
        const agentId = interaction.options.getString("agent")
        const schedule = interaction.options.getString("schedule")
        const paramsStr = interaction.options.getString("params")
        const scriptFile = interaction.options.getAttachment("script_file")

        try {
            // Validate task name
            const nameError = validateTaskName(name)
            if (nameError) {
                return interaction.reply({
                    content: `❌ ${nameError}`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Check for existing task
            const existing = await db.Task.findOne({
                where: { name }
            })
            if (existing) {
                return interaction.reply({
                    content: `❌ Task \`${name}\` already exists.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Validate schedule if provided
            if (schedule) {
                const scheduleError = validateSchedule(schedule)
                if (scheduleError) {
                    return interaction.reply({
                        content: `❌ ${scheduleError}`,
                        flags: [MessageFlags.Ephemeral]
                    })
                }
            }

            // Validate agent exists
            const agent = await db.Agent.findOne({
                where: { agentId }
            })
            if (!agent) {
                return interaction.reply({
                    content: `❌ Agent \`${agentId}\` not found.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Parse and validate parameters if provided
            let params = {}
            if (paramsStr) {
                try {
                    params = JSON.parse(paramsStr)
                    if (typeof params !== "object" || Array.isArray(params)) {
                        throw new Error("Parameters must be a JSON object")
                    }
                } catch (err) {
                    return interaction.reply({
                        content: "❌ Invalid JSON parameters format.",
                        flags: [MessageFlags.Ephemeral]
                    })
                }
            }

            // Handle script file if provided
            if (scriptFile) {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })
                try {
                    // Validate file extension based on type
                    const fileExtensions = {
                        bash: ['.sh', '.bash'],
                        python: ['.py'],
                        node: ['.js']
                    }
                    
                    const fileName = scriptFile.name.toLowerCase()
                    const validExtensions = fileExtensions[type]
                    
                    if (!validExtensions.some(ext => fileName.endsWith(ext))) {
                        return interaction.editReply({
                            content: `❌ Invalid file extension for ${type} script. Expected: ${validExtensions.join(', ')}`,
                        })
                    }

                    // Download and read file content
                    const response = await fetch(scriptFile.url)
                    if (!response.ok) {
                        throw new Error('Failed to download file')
                    }
                    const scriptContent = await response.text()

                    // Create task directly
                    const task = await db.Task.create({
                        name,
                        type,
                        script: scriptContent,
                        agentId,
                        schedule,
                        params,
                        enabled: true
                    })

                    return interaction.editReply({
                        content: `✅ Task \`${name}\` created successfully!`
                    })

                } catch (err) {
                    logger.error("❌ Failed to process script file:", err)
                    return interaction.editReply({
                        content: "❌ Failed to process script file."
                    })
                }
            }

            // If no file provided, open script editor modal
            const modalId = [
                'create-task',
                name,
                type,
                agentId,
                schedule || '_',
                Object.keys(params).length ? Buffer.from(JSON.stringify(params)).toString('base64') : '_'
            ].join('|')
            
            const modal = new ModalBuilder()
                .setCustomId(modalId)
                .setTitle(`Create Task: ${name}`)

            const scriptInput = new TextInputBuilder()
                .setCustomId("script")
                .setLabel(`${type.charAt(0).toUpperCase() + type.slice(1)} Script`)
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder(`Enter your ${type} script here...`)
                .setRequired(true)

            const row = new ActionRowBuilder().addComponents(scriptInput)
            modal.addComponents(row)

            await interaction.showModal(modal)

        } catch (err) {
            logger.error("❌ Failed to create task:", err)
            return interaction.reply({
                content: "❌ Failed to create task.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
