const { SlashCommandSubcommandBuilder, EmbedBuilder, MessageFlags } = require("discord.js")
const fs = require("fs")
const path = require("path")
const startStatusUpdater = require("../../statusUpdater")

const configPath = path.join(__dirname, "../../config/status-message.json")

module.exports = {
    data: new SlashCommandSubcommandBuilder().setName("status").setDescription("Create and save the live status embed"),

    async execute(interaction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] })

        const embed = new EmbedBuilder()
            .setTitle("📡 Automi System Status")
            .setDescription("⏳ Initializing...")
            .setColor("#00bcd4")
            .setTimestamp()

        const msg = await interaction.channel.send({ embeds: [embed] })

        const payload = {
            channelId: msg.channel.id,
            messageId: msg.id
        }

        // Ensure config directory exists
        const configDir = path.dirname(configPath)
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true })
        }

        // Write config file
        fs.writeFileSync(configPath, JSON.stringify(payload, null, 4))

        setTimeout(() => {
            startStatusUpdater(interaction.client)
        }, 1000)

        return interaction.editReply("✅ Status message initialized and saved.")
    }
}
