/**
 * Asset Add Command
 * Adds a new global asset to the system
 */
const {
    SlashCommandSubcommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    ActionRowBuilder,
    TextInputStyle
} = require("discord.js")
const logger = require("../../../utils/logger")

module.exports = {
    data: new SlashCommandSubcommandBuilder().setName("add").setDescription("Add a new global asset"),

    async execute(interaction) {
        try {
            // Create modal for asset input
            const modal = new ModalBuilder().setCustomId("add-asset-modal").setTitle("Add New Asset")

            // Create text inputs
            const keyInput = new TextInputBuilder()
                .setCustomId("key")
                .setLabel("Asset Key")
                .setStyle(TextInputStyle.Short)
                .setPlaceholder("Enter asset key (e.g. API_TOKEN)")
                .setRequired(true)
                .setMaxLength(50)

            const valueInput = new TextInputBuilder()
                .setCustomId("value")
                .setLabel("Asset Value")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("Enter asset value")
                .setRequired(true)

            const descriptionInput = new TextInputBuilder()
                .setCustomId("description")
                .setLabel("Description (Optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder("Describe what this asset is used for")
                .setRequired(false)

            // Add inputs to the modal
            modal.addComponents(
                new ActionRowBuilder().addComponents(keyInput),
                new ActionRowBuilder().addComponents(valueInput),
                new ActionRowBuilder().addComponents(descriptionInput)
            )

            // Show the modal
            await interaction.showModal(modal)
        } catch (err) {
            logger.error("❌ Error preparing asset add form:", err)
            return interaction.reply({
                content: "An error occurred while preparing the asset form. Please check the logs.",
                ephemeral: true
            })
        }
    }
}
