/**
 * Agent Add Command
 * Registers new agent with authentication token and IP restrictions
 */
const { SlashCommandSubcommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js")
const crypto = require("crypto")
const logger = require("../../../utils/logger")
const db = require("../../../db")

/**
 * Generate secure authentication token
 * @returns {string} Random token
 */
function generateToken() {
    return crypto.randomBytes(32).toString("hex")
}

/**
 * Validate agent ID format
 * @param {string} agentId Agent ID to validate
 * @returns {string|null} Error message if invalid, null if valid
 */
function validateAgentId(agentId) {
    if (!agentId || agentId.length < 3 || agentId.length > 50) {
        return "Agent ID must be between 3 and 50 characters"
    }
    if (!/^[a-zA-Z0-9-_]+$/.test(agentId)) {
        return "Agent ID can only contain letters, numbers, hyphens, and underscores"
    }
    return null
}

/**
 * Validate IP address format
 * @param {string} ip IP address to validate
 * @returns {boolean} True if valid
 */
function validateIpAddress(ip) {
    if (!ip) return false
    
    // Check IPv4
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
    if (ipv4Regex.test(ip)) {
        const parts = ip.split(".")
        return parts.every(part => {
            const num = parseInt(part, 10)
            return !isNaN(num) && num >= 0 && num <= 255
        })
    }
    
    // Check IPv6 - handles various formats including ::ffff:127.0.0.1
    const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/
    return ipv6Regex.test(ip)
}

/**
 * Create embed with agent configuration
 * @param {Object} agent Agent record
 * @param {string} token Generated token
 * @returns {EmbedBuilder} Discord embed
 */
function createConfigEmbed(agent, token) {
    return new EmbedBuilder()
        .setTitle(`🤖 New Agent: ${agent.agentId}`)
        .setColor("#00bcd4")
        .setDescription("Agent has been registered successfully. Use this configuration in your agent's config.json:")
        .addFields([
            {
                name: "Configuration",
                value: `\`\`\`json
{
    "agentId": "${agent.agentId}",
    "token": "${token}",
    "controllerUrl": "ws://your-controller:4000"
}
\`\`\``
            },
            {
                name: "IP Whitelist",
                value: agent.ipWhitelist?.length > 0 ? agent.ipWhitelist.join(", ") : "No IP restrictions"
            }
        ])
}

module.exports = {
    data: new SlashCommandSubcommandBuilder()
        .setName("add")
        .setDescription("Register a new agent")
        .addStringOption(opt =>
            opt.setName("id").setDescription("Agent ID (letters, numbers, hyphens, underscores)").setRequired(true)
        )
        .addStringOption(opt => opt.setName("ip").setDescription("Allowed IP address (optional)").setRequired(false)),

    async execute(interaction) {
        const agentId = interaction.options.getString("id")
        const ip = interaction.options.getString("ip")

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

        try {
            // Validate agent ID
            const idError = validateAgentId(agentId)
            if (idError) {
                return interaction.editReply({
                    content: `❌ ${idError}`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Check for existing agent
            const existing = await db.Agent.findOne({
                where: { agentId }
            })
            if (existing) {
                return interaction.editReply({
                    content: `❌ Agent \`${agentId}\` already exists.`,
                    flags: [MessageFlags.Ephemeral]
                })
            }

            // Validate IP if provided
            let ipWhitelist = []
            if (ip) {
                if (!validateIpAddress(ip)) {
                    return interaction.editReply({
                        content: "❌ Invalid IP address format.",
                        flags: [MessageFlags.Ephemeral]
                    })
                }
                ipWhitelist = [ip]
            }

            // Generate token and create agent
            const token = generateToken()
            const agent = await db.Agent.create({
                agentId,
                token,
                ipWhitelist,
                status: "offline",
                lastSeen: null
            })

            logger.info(`✅ Created new agent: ${agentId}`)

            // Send configuration
            const embed = createConfigEmbed(agent, token)
            return interaction.editReply({
                content: "✅ Agent registered successfully. Keep this token secret!",
                embeds: [embed],
                flags: [MessageFlags.Ephemeral]
            })
        } catch (err) {
            logger.error("❌ Failed to register agent:", err)
            return interaction.editReply({
                content: "❌ Failed to register agent.",
                flags: [MessageFlags.Ephemeral]
            })
        }
    }
}
