/**
 * Modal Submit Handler
 * Processes submissions from Discord modals, particularly for task editing
 */
const { MessageFlags } = require("discord.js")
const logger = require("../../utils/logger")
const db = require("../../db")

/**
 * Maximum script size to accept (100KB)
 */
const MAX_SCRIPT_SIZE = 100 * 1024

/**
 * Validate script content for security and size
 * @param {string} script - Script content to validate
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateScript(script) {
    if (!script || !script.trim()) {
        return "Script content cannot be empty"
    }

    if (script.length > MAX_SCRIPT_SIZE) {
        return `Script exceeds maximum size of ${MAX_SCRIPT_SIZE} bytes`
    }

    // Add additional security validations here as needed
    return null
}

/**
 * Handle task script edit modal submission
 * @param {ModalSubmitInteraction} interaction Modal submission interaction
 * @param {string} taskName Name of task being edited
 * @returns {Promise<void>}
 */
async function handleTaskEdit(interaction, taskName) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

    try {
        // Get script content from modal
        const script = interaction.fields.getTextInputValue("script")

        // Validate script content
        const validationError = validateScript(script)
        if (validationError) {
            logger.warn(`⚠️ Invalid script submission for ${taskName}: ${validationError}`)
            return interaction.editReply({
                content: `❌ ${validationError}`,
                flags: [MessageFlags.Ephemeral]
            })
        }

        // Find and update task
        const task = await db.Task.findOne({ where: { name: taskName } })
        if (!task) {
            logger.warn(`⚠️ Task not found for script edit: ${taskName}`)
            return interaction.editReply({
                content: `❌ Task \`${taskName}\` not found.`,
                flags: [MessageFlags.Ephemeral]
            })
        }

        // Update task script
        await task.update({ script })
        logger.info(`✅ Updated script for task: ${taskName}`)

        // Format preview of script changes
        const previewLength = 100
        const scriptPreview = script.length > previewLength
            ? script.substring(0, previewLength) + "..."
            : script

        return interaction.editReply({
            content: `✅ Script updated for task \`${taskName}\`\n\`\`\`\n${scriptPreview}\n\`\`\``,
            flags: [MessageFlags.Ephemeral]
        })
    } catch (err) {
        logger.error(`❌ Error processing script edit for ${taskName}:`, err)
        return interaction.editReply({
            content: "❌ Failed to update task script.",
            flags: [MessageFlags.Ephemeral]
        })
    }
}

/**
 * Handle task creation modal submission
 * @param {ModalSubmitInteraction} interaction Modal submission interaction
 * @param {string} modalId Modal ID containing task details
 * @returns {Promise<void>}
 */
async function handleTaskCreate(interaction, modalId) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

    try {
        // Parse task details from modal ID
        const [_, name, type, agentId, schedule, paramsEncoded] = modalId.split('|')
        const params = paramsEncoded !== '_' ? 
            JSON.parse(Buffer.from(paramsEncoded, 'base64').toString()) : 
            {}

        // Get script content from modal
        const script = interaction.fields.getTextInputValue("script")

        // Validate script content
        const validationError = validateScript(script)
        if (validationError) {
            logger.warn(`⚠️ Invalid script submission for new task ${name}: ${validationError}`)
            return interaction.editReply({
                content: `❌ ${validationError}`
            })
        }

        // Create new task
        const task = await db.Task.create({
            name,
            type,
            script,
            agentId,
            schedule: schedule === '_' ? null : schedule,
            params,
            enabled: true
        })

        logger.info(`✅ Created new task: ${name}`)

        // Format preview of script
        const previewLength = 100
        const scriptPreview = script.length > previewLength
            ? script.substring(0, previewLength) + "..."
            : script

        return interaction.editReply({
            content: `✅ Created task \`${name}\`\n\`\`\`\n${scriptPreview}\n\`\`\``
        })
    } catch (err) {
        logger.error(`❌ Error creating new task:`, err)
        return interaction.editReply({
            content: "❌ Failed to create task."
        })
    }
}

/**
 * Process modal submissions
 * @param {ModalSubmitInteraction} interaction Modal submission interaction
 */
async function handleModalSubmit(interaction) {
    const modalId = interaction.customId

    // Handle task creation modal
    if (modalId.startsWith("create-task")) {
        await handleTaskCreate(interaction, modalId)
        return
    }

    // Handle task edit modal
    if (modalId.startsWith("edit-task-")) {
        const taskName = modalId.replace("edit-task-", "")
        await handleTaskEdit(interaction, taskName)
        return
    }

    // Handle unknown modal
    logger.warn(`⚠️ Unknown modal submission: ${modalId}`)
    await interaction.reply({
        content: "❌ Unknown modal type.",
        flags: [MessageFlags.Ephemeral]
    })
}

module.exports = handleModalSubmit
