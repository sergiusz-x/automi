const { SlashCommandBuilder, MessageFlags } = require("discord.js")
const fs = require("fs")
const path = require("path")
const logger = require("../../utils/logger")

const subcommands = new Map()
const subDir = path.join(__dirname, "log")

for (const file of fs.readdirSync(subDir).filter(f => f.endsWith(".js"))) {
    const sub = require(path.join(subDir, file))
    if (!sub?.data?.name) {
        logger.warn(`⚠️ Skipped invalid subcommand file: ${file}`)
        continue
    }
    subcommands.set(sub.data.name, sub)
}

const data = new SlashCommandBuilder().setName("log").setDescription("View task execution logs")

for (const sub of subcommands.values()) {
    data.addSubcommand(sub.data)
}

module.exports = {
    data,

    async execute(interaction) {
        const sub = interaction.options.getSubcommand()
        const handler = subcommands.get(sub)
        if (handler) {
            return handler.execute(interaction)
        }
        return interaction.reply({ content: "❌ Unknown subcommand.", flags: [MessageFlags.Ephemeral] })
    },

    async autocomplete(interaction) {
        const sub = interaction.options.getSubcommand()
        const handler = subcommands.get(sub)
        if (handler?.autocomplete) {
            return handler.autocomplete(interaction)
        }
    }
}
