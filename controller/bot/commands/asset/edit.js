/**
 * Asset Edit Command
 * Edits an existing global asset
 */
const {
    SlashCommandSubcommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    ActionRowBuilder,
    TextInputStyle
} = require("discord.js")
const db = require("../../../db")
const logger = require("../../../utils/logger")

module.exports = {
    // Define command
    data: new SlashCommandSubcommandBuilder()
        .setName("edit")
        .setDescription("Edit an existing global asset")
        .addStringOption(option =>
            option.setName("key").setDescription("The key of the asset to edit").setRequired(true).setAutocomplete(true)
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
            logger.error("❌ Error in asset edit autocomplete:", err)
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

            // Create modal for asset edit
            const modal = new ModalBuilder()
                .setCustomId(`edit-asset-modal-${asset.key}`)
                .setTitle(`Edit Asset: ${asset.key}`)

            // Create text inputs with current values
            const valueInput = new TextInputBuilder()
                .setCustomId("value")
                .setLabel("Asset Value")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(asset.value)
                .setRequired(true)

            const descriptionInput = new TextInputBuilder()
                .setCustomId("description")
                .setLabel("Description (Optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(asset.description || "")
                .setRequired(false)

            // Add inputs to the modal
            modal.addComponents(
                new ActionRowBuilder().addComponents(valueInput),
                new ActionRowBuilder().addComponents(descriptionInput)
            )

            // Show the modal
            await interaction.showModal(modal)
        } catch (err) {
            logger.error("❌ Error preparing asset edit form:", err)
            return interaction.reply({
                content: "An error occurred while preparing the asset edit form. Please check the logs.",
                ephemeral: true
            })
        }
    }
}
