/**
 * Modal Submit Handler
 * Processes submissions from Discord modals, particularly for task editing
 */
const { MessageFlags, EmbedBuilder } = require("discord.js")
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
 * Validate IP address list
 * @param {string[]} ips Array of IP addresses to validate
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateIpList(ips) {
    if (!Array.isArray(ips)) return "IP list must be an array"

    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
    const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/

    for (const ip of ips) {
        if (ip === "*") continue
        
        // IPv4 validation
        if (ipv4Regex.test(ip)) {
            // Validate each octet
            const parts = ip.split(".")
            for (const part of parts) {
                const num = parseInt(part, 10)
                if (num < 0 || num > 255) {
                    return `Invalid IP address (octet out of range): ${ip}`
                }
            }
            continue
        }
        
        // IPv6 validation
        if (ipv6Regex.test(ip)) {
            continue
        }
        
        return `Invalid IP address: ${ip}`
    }
    return null
}

/**
 * Create IP whitelist update embed
 * @param {Object} params Parameters for embed creation
 * @returns {EmbedBuilder} Discord embed
 */
function createIpUpdateEmbed(params) {
    const { agentId, oldIps, newIps, isOnline, lastSeen } = params
    const statusEmoji = isOnline ? "🟢" : "🔴"
    const lastSeenText = lastSeen > 0 ? `<t:${Math.floor(lastSeen / 1000)}:R>` : "Never"

    return new EmbedBuilder()
        .setTitle(`🔒 IP Whitelist Updated: ${agentId}`)
        .setColor("#00bcd4")
        .addFields([
            {
                name: "Status",
                value: `${statusEmoji} ${isOnline ? "Online" : "Offline"}`,
                inline: true
            },
            {
                name: "Last Seen",
                value: lastSeenText,
                inline: true
            },
            {
                name: "Previous Whitelist",
                value: oldIps.length > 0 ? `\`${oldIps.join(", ")}\`` : "*No restrictions*",
                inline: false
            },
            {
                name: "New Whitelist",
                value: newIps.length > 0 ? `\`${newIps.join(", ")}\`` : "*No restrictions*",
                inline: false
            }
        ])
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
        const scriptPreview = script.length > previewLength ? script.substring(0, previewLength) + "..." : script

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
        const [_, name, type, agentId, schedule, paramsEncoded] = modalId.split("|")
        const params = paramsEncoded !== "_" ? JSON.parse(Buffer.from(paramsEncoded, "base64").toString()) : {}

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
            schedule: schedule === "_" ? null : schedule,
            params,
            enabled: true
        })

        logger.info(`✅ Created new task: ${name}`)

        // Format preview of script
        const previewLength = 100
        const scriptPreview = script.length > previewLength ? script.substring(0, previewLength) + "..." : script

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
 * Handle agent IP whitelist edit modal submission
 * @param {ModalSubmitInteraction} interaction Modal submission interaction
 * @param {string} modalId Modal ID containing agent details
 * @returns {Promise<void>}
 */
async function handleAgentIpEdit(interaction, modalId) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

    try {
        // Parse modal ID data
        const [_, agentId] = modalId.split("|")
        if (!agentId) {
            return interaction.editReply({
                content: "❌ Invalid agent ID in modal data.",
                flags: [MessageFlags.Ephemeral]
            })
        }

        const ipList = interaction.fields
            .getTextInputValue("ipWhitelist")
            .split(",")
            .map(ip => ip.trim())
            .filter(ip => ip)

        // Find agent
        const agent = await db.Agent.findOne({ where: { agentId } })
        if (!agent) {
            return interaction.editReply({
                content: `❌ Agent \`${agentId}\` not found.`,
                flags: [MessageFlags.Ephemeral]
            })
        }

        // Get current IPs for comparison
        const currentIps = Array.isArray(agent.ipWhitelist)
            ? agent.ipWhitelist
            : JSON.parse(agent.ipWhitelist || '["*"]')

        // Validate IP list
        const validationError = validateIpList(ipList)
        if (validationError) {
            return interaction.editReply({
                content: `❌ ${validationError}`,
                flags: [MessageFlags.Ephemeral]
            })
        }

        // Create embed
        const embed = new EmbedBuilder()
            .setTitle(`🔒 IP Whitelist Updated: ${agentId}`)
            .setColor("#00bcd4")
            .addFields([
                {
                    name: "Previous Whitelist",
                    value: currentIps.length > 0 ? `\`${currentIps.join(", ")}\`` : "*No restrictions*",
                    inline: false
                },
                {
                    name: "New Whitelist",
                    value: ipList.length > 0 ? `\`${ipList.join(", ")}\`` : "*No restrictions*",
                    inline: false
                }
            ])

        // Update IP whitelist
        await agent.update({ ipWhitelist: ipList })
        logger.info(`✅ Updated IP whitelist for agent ${agentId}`)

        return interaction.editReply({
            content: "✅ IP whitelist updated successfully.",
            embeds: [embed],
            flags: [MessageFlags.Ephemeral]
        })
    } catch (err) {
        logger.error("Error updating agent IP whitelist:", err)
        return interaction.editReply({
            content: "❌ Failed to update IP whitelist.",
            flags: [MessageFlags.Ephemeral]
        })
    }
}

/**
 * Handle asset add modal submission
 * @param {ModalSubmitInteraction} interaction Modal submission interaction
 * @returns {Promise<void>}
 */
async function handleAssetAdd(interaction) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

    try {
        // Get asset data from modal
        const key = interaction.fields.getTextInputValue("key")
        const value = interaction.fields.getTextInputValue("value")
        const description = interaction.fields.getTextInputValue("description") || null

        // Validate key (should be non-empty)
        if (!key || !key.trim()) {
            return interaction.editReply({
                content: "❌ Asset key cannot be empty.",
                flags: [MessageFlags.Ephemeral]
            })
        }

        // Check if asset with this key already exists
        const existingAsset = await db.Asset.findOne({ where: { key } })
        if (existingAsset) {
            return interaction.editReply({
                content: `❌ Asset with key \`${key}\` already exists.`,
                flags: [MessageFlags.Ephemeral]
            })
        }

        // Create new asset
        const asset = await db.Asset.create({
            key,
            value,
            description
        })

        logger.info(`✅ Created new asset: ${key}`)

        // Create embed for asset details
        const embed = new EmbedBuilder()
            .setTitle("✅ Asset Created")
            .setColor("#2ecc71")
            .setDescription(`The asset **${key}** has been created successfully.`)
            .addFields([
                {
                    name: "Key",
                    value: `\`${key}\``,
                    inline: true
                },
                {
                    name: "Value",
                    value: `\`${value}\``,
                    inline: true
                }
            ])

        if (description) {
            embed.addFields({
                name: "Description",
                value: description,
                inline: false
            })
        }

        return interaction.editReply({
            embeds: [embed],
            flags: [MessageFlags.Ephemeral]
        })
    } catch (err) {
        logger.error("❌ Error creating asset:", err)
        return interaction.editReply({
            content: "❌ Failed to create asset.",
            flags: [MessageFlags.Ephemeral]
        })
    }
}

/**
 * Handle asset edit modal submission
 * @param {ModalSubmitInteraction} interaction Modal submission interaction
 * @param {string} assetKey Key of the asset being edited
 * @returns {Promise<void>}
 */
async function handleAssetEdit(interaction, assetKey) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

    try {
        // Get asset data from modal
        const value = interaction.fields.getTextInputValue("value")
        const description = interaction.fields.getTextInputValue("description") || null

        // Find asset
        const asset = await db.Asset.findOne({ where: { key: assetKey } })
        if (!asset) {
            return interaction.editReply({
                content: `❌ Asset with key \`${assetKey}\` not found.`,
                flags: [MessageFlags.Ephemeral]
            })
        }

        // Track old values for comparison
        const oldValue = asset.value
        const oldDescription = asset.description

        // Update asset
        await asset.update({
            value,
            description
        })

        logger.info(`✅ Updated asset: ${assetKey}`)

        // Create embed for asset details
        const embed = new EmbedBuilder()
            .setTitle("✅ Asset Updated")
            .setColor("#3498db")
            .setDescription(`The asset **${assetKey}** has been updated successfully.`)
            .addFields([
                {
                    name: "Key",
                    value: `\`${assetKey}\``,
                    inline: false
                },
                {
                    name: "Previous Value",
                    value: `\`${oldValue}\``,
                    inline: true
                },
                {
                    name: "New Value",
                    value: `\`${value}\``,
                    inline: true
                }
            ])

        if (oldDescription !== description) {
            embed.addFields([
                {
                    name: "Previous Description",
                    value: oldDescription || "*No description*",
                    inline: true
                },
                {
                    name: "New Description",
                    value: description || "*No description*",
                    inline: true
                }
            ])
        }

        return interaction.editReply({
            embeds: [embed],
            flags: [MessageFlags.Ephemeral]
        })
    } catch (err) {
        logger.error(`❌ Error updating asset ${assetKey}:`, err)
        return interaction.editReply({
            content: "❌ Failed to update asset.",
            flags: [MessageFlags.Ephemeral]
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

    // Handle agent IP edit modal
    if (modalId.startsWith("edit-agent-ip")) {
        await handleAgentIpEdit(interaction, modalId)
        return
    }

    // Handle asset add modal
    if (modalId.startsWith("add-asset")) {
        await handleAssetAdd(interaction)
        return
    }

    // Handle asset edit modal
    if (modalId.startsWith("edit-asset-modal-")) {
        const assetKey = modalId.replace("edit-asset-modal-", "")
        await handleAssetEdit(interaction, assetKey)
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
