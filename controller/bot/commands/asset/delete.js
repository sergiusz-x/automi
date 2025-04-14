/**
 * Asset Delete Command
 * Removes an existing global asset from the system
 */
const {
    SlashCommandSubcommandBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder
} = require("discord.js")
const db = require("../../../db")
const logger = require("../../../utils/logger")

module.exports = {
    // Define command
    data: new SlashCommandSubcommandBuilder()
        .setName("delete")
        .setDescription("Delete an existing global asset")
        .addStringOption(option =>
            option
                .setName("key")
                .setDescription("The key of the asset to delete")
                .setRequired(true)
                .setAutocomplete(true)
        ),

    // Add autocomplete support for asset keys
    async autocomplete(interaction) {
        try {
            // Get the focused value
            const focusedValue = interaction.options.getFocused()

            // Get all assets and filter them
            const assets = await db.Asset.findAll({
                order: [["key", "ASC"]],
                attributes: ["key"]
            })

            const filtered = assets
                .map(asset => asset.key)
                .filter(choice => choice.toLowerCase().includes(focusedValue.toLowerCase()))
                .slice(0, 25) // Discord allows max 25 choices

            await interaction.respond(
                filtered.map(choice => ({
                    name: choice,
                    value: choice
                }))
            )
        } catch (err) {
            logger.error("❌ Error in asset delete autocomplete:", err)
            // Return empty array on error
            await interaction.respond([])
        }
    },

    // Execute command
    async execute(interaction) {
        try {
            const assetKey = interaction.options.getString("key")

            // Fetch the asset
            const asset = await db.Asset.findOne({
                where: { key: assetKey }
            })

            if (!asset) {
                return interaction.reply({
                    content: `Asset with key \`${assetKey}\` not found.`,
                    ephemeral: true
                })
            }

            // Create confirmation embed
            const embed = new EmbedBuilder()
                .setTitle("🗑️ Confirm Asset Deletion")
                .setColor("#e74c3c")
                .setDescription(`Are you sure you want to delete the asset **${asset.key}**?`)
                .addFields(
                    { name: "Value", value: `\`${asset.value}\`` },
                    { name: "Description", value: asset.description || "No description provided" }
                )

            // Create confirmation buttons
            const confirmButton = new ButtonBuilder()
                .setCustomId(`delete-asset-confirm-${asset.key}`)
                .setLabel("Delete")
                .setStyle(ButtonStyle.Danger)

            const cancelButton = new ButtonBuilder()
                .setCustomId(`delete-asset-cancel-${asset.key}`)
                .setLabel("Cancel")
                .setStyle(ButtonStyle.Secondary)

            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton)

            // Send confirmation message and get the message for creating a collector
            const message = await interaction
                .reply({
                    embeds: [embed],
                    components: [row]
                })
                .then(sent => interaction.fetchReply())

            // Create collector for button interaction
            const collector = message.createMessageComponentCollector({
                time: 30000 // 30 seconds timeout
            })

            collector.on("collect", async i => {
                if (i.user.id !== interaction.user.id) {
                    return i.reply({
                        content: "You cannot use these buttons.",
                        ephemeral: true
                    })
                }

                const customId = i.customId

                if (customId === `delete-asset-confirm-${asset.key}`) {
                    try {
                        // Delete the asset
                        await asset.destroy()

                        // Update the embed
                        const successEmbed = new EmbedBuilder()
                            .setTitle("✅ Asset Deleted")
                            .setColor("#2ecc71")
                            .setDescription(`The asset **${asset.key}** has been deleted successfully.`)

                        await i.update({
                            embeds: [successEmbed],
                            components: []
                        })
                    } catch (err) {
                        logger.error(`❌ Error deleting asset ${asset.key}:`, err)

                        // Show error message
                        await i.update({
                            content: "❌ An error occurred while deleting the asset. Please check the logs.",
                            embeds: [],
                            components: []
                        })
                    }
                } else if (customId === `delete-asset-cancel-${asset.key}`) {
                    // Update the embed
                    const cancelEmbed = new EmbedBuilder()
                        .setTitle("❌ Deletion Cancelled")
                        .setColor("#95a5a6")
                        .setDescription(`Deletion of asset **${asset.key}** has been cancelled.`)

                    await i.update({
                        embeds: [cancelEmbed],
                        components: []
                    })
                }

                collector.stop()
            })

            collector.on("end", async collected => {
                if (collected.size === 0) {
                    // Timeout - update the message
                    const timeoutEmbed = new EmbedBuilder()
                        .setTitle("⏱️ Deletion Timed Out")
                        .setColor("#95a5a6")
                        .setDescription(`The deletion confirmation for asset **${asset.key}** has timed out.`)

                    await interaction.editReply({
                        embeds: [timeoutEmbed],
                        components: []
                    })
                }
            })
        } catch (err) {
            logger.error("❌ Error handling asset deletion:", err)
            return interaction.reply({
                content: "An error occurred while trying to delete the asset. Please check the logs.",
                ephemeral: true
            })
        }
    }
}
