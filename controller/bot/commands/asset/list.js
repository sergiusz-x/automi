/**
 * Asset List Command
 * Lists all global assets in the system
 */
const {
    SlashCommandSubcommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js")
const db = require("../../../db")
const logger = require("../../../utils/logger")

/**
 * Create navigation buttons for paging
 * @param {number} currentPage - Current page index
 * @param {number} totalPages - Total number of pages
 * @returns {ActionRowBuilder} Row with pagination buttons
 */
function createNavigationRow(currentPage, totalPages) {
    const row = new ActionRowBuilder()

    // Previous button
    row.addComponents(
        new ButtonBuilder()
            .setCustomId("prev")
            .setLabel("Previous")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 0)
    )

    // Next button
    row.addComponents(
        new ButtonBuilder()
            .setCustomId("next")
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === totalPages - 1)
    )

    return row
}

module.exports = {
    data: new SlashCommandSubcommandBuilder().setName("list").setDescription("List all global assets"),

    async execute(interaction) {
        try {
            await interaction.deferReply()

            // Fetch all assets
            const assets = await db.Asset.findAll({
                order: [["key", "ASC"]]
            })

            if (assets.length === 0) {
                return interaction.editReply("No assets found in the system.")
            }

            // Create embeds (multiple if needed)
            const assetsPaging = []
            const itemsPerPage = 10

            for (let i = 0; i < assets.length; i += itemsPerPage) {
                const pageAssets = assets.slice(i, i + itemsPerPage)

                const embed = new EmbedBuilder()
                    .setTitle("🔑 Global Assets")
                    .setColor("#3498db")
                    .setDescription("Assets that can be used by all tasks as environment variables")

                // Add each asset as its own field to avoid exceeding Discord's field length limits
                const fields = pageAssets.map(asset => {
                    let value = `Value: \`${asset.value}\``
                    if (asset.description) value += `\nDescription: ${asset.description}`
                    return { name: asset.key, value, inline: false }
                })
                embed.addFields(fields)

                if (assets.length > itemsPerPage) {
                    embed.setFooter({
                        text: `Page ${Math.floor(i / itemsPerPage) + 1}/${Math.ceil(assets.length / itemsPerPage)}`
                    })
                }

                assetsPaging.push(embed)
            }

            // Send first page
            const message = await interaction.editReply({
                embeds: [assetsPaging[0]],
                components: assetsPaging.length > 1 ? [createNavigationRow(0, assetsPaging.length)] : []
            })

            // If we have multiple pages, add navigation
            if (assetsPaging.length > 1) {
                const collector = message.createMessageComponentCollector({ time: 300000 }) // 5 minutes

                let currentPage = 0

                collector.on("collect", async i => {
                    if (i.user.id !== interaction.user.id) {
                        return i.reply({
                            content: "You cannot use these buttons.",
                            ephemeral: true
                        })
                    }

                    if (i.customId === "prev") {
                        currentPage = Math.max(0, currentPage - 1)
                    } else if (i.customId === "next") {
                        currentPage = Math.min(assetsPaging.length - 1, currentPage + 1)
                    }

                    await i.update({
                        embeds: [assetsPaging[currentPage]],
                        components: [createNavigationRow(currentPage, assetsPaging.length)]
                    })
                })

                collector.on("end", () => {
                    interaction
                        .editReply({
                            components: []
                        })
                        .catch(() => {}) // Ignore errors if message was deleted
                })
            }
        } catch (err) {
            logger.error("❌ Error listing assets:", err)
            return interaction.editReply("An error occurred while listing assets. Please check the logs.")
        }
    }
}
