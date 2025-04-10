const fs = require("fs")
const path = require("path")
const { SlashCommandBuilder, MessageFlags } = require("discord.js")
const logger = require("../../utils/logger")

const subcommands = new Map()
const subDir = path.join(__dirname, "config")

for (const file of fs.readdirSync(subDir).filter(f => f.endsWith(".js"))) {
    const sub = require(path.join(subDir, file))
    if (!sub?.data?.name) {
        logger.warn(`⚠️ Skipped invalid subcommand file: ${file}`)
        continue
    }
    subcommands.set(sub.data.name, sub)
}

const data = new SlashCommandBuilder().setName("config").setDescription("Bot configuration commands")

for (const sub of subcommands.values()) {
    data.addSubcommand(sub.data)
}

module.exports = {
    data,
    async execute(interaction) {
        const sub = subcommands.get(interaction.options.getSubcommand())
        if (!sub) {
            return interaction.reply({ content: "❌ Subcommand not found.", flags: [MessageFlags.Ephemeral] })
        }

        return sub.execute(interaction)
    }
}
