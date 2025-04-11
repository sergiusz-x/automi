/**
 * Discord Bot Module
 * Manages command registration, interaction handling, and bot lifecycle
 */
const { Client, GatewayIntentBits, Collection, Events, REST, Routes, MessageFlags } = require("discord.js")
const config = require("../utils/config")
const logger = require("../utils/logger")
const fs = require("fs")
const path = require("path")
const handleModalSubmit = require("./listeners/modalSubmit")

// Initialize Discord client with required intents
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
})

// Command collection for fast lookup
client.commands = new Collection()
const commands = []

/**
 * Load and register command modules
 * @returns {Promise<void>}
 */
async function loadCommands() {
    const commandsDir = path.join(__dirname, "commands")

    // Check if directory exists
    if (!fs.existsSync(commandsDir)) {
        logger.error(`❌ Commands directory not found at ${commandsDir}`)
        return
    }

    const commandFiles = fs
        .readdirSync(commandsDir)
        .filter(file => file.endsWith(".js") && !fs.statSync(path.join(commandsDir, file)).isDirectory())

    logger.info(`🔍 Found ${commandFiles.length} command files`)

    for (const file of commandFiles) {
        try {
            const filePath = path.join(commandsDir, file)
            // Check if file is empty
            const stats = fs.statSync(filePath)
            if (stats.size === 0) {
                logger.warn(`⚠️ Skipping empty command file: ${file}`)
                continue
            }

            // Try to load the command
            const command = require(filePath)

            // Validation of command structure
            if (!command) {
                logger.warn(`⚠️ Command file does not export anything: ${file}`)
                continue
            }

            if (!command.data) {
                logger.warn(`⚠️ Command does not have data property: ${file}`)
                continue
            }

            if (!command.data.toJSON) {
                logger.warn(`⚠️ Command data is not a SlashCommandBuilder: ${file}`)
                continue
            }

            if (!command.execute || typeof command.execute !== "function") {
                logger.warn(`⚠️ Command is missing execute function: ${file}`)
                continue
            }

            // Register the command
            client.commands.set(command.data.name, command)
            commands.push(command.data.toJSON())
            logger.info(`🧩 Loaded command: /${command.data.name}`)
        } catch (err) {
            logger.error(`❌ Failed to load command from ${file}:`, err)
        }
    }
}

/**
 * Deploy slash commands to Discord if changes detected
 * @returns {Promise<void>}
 */
async function deployCommandsIfNeeded() {
    const cachePath = path.join(__dirname, ".bot_commands_cache.json")
    const newCache = JSON.stringify(commands, null, 4)
    let shouldDeploy = true

    try {
        if (fs.existsSync(cachePath)) {
            const existingCache = fs.readFileSync(cachePath, "utf8")
            if (existingCache === newCache) {
                shouldDeploy = false
            }
        }

        if (!shouldDeploy) {
            logger.info("🟡 No changes in commands — skipping deployment")
            return
        }

        const rest = new REST({ version: "10" }).setToken(config.discord.botToken)

        logger.info("📡 Deploying slash commands to Discord...")
        await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
            body: commands
        })

        fs.writeFileSync(cachePath, newCache)
        logger.info("✅ Commands deployed successfully")
    } catch (err) {
        logger.error("❌ Failed to deploy commands:", err)
        throw err
    }
}

/**
 * Handle Discord interactions (commands, autocomplete, modals)
 * @param {Interaction} interaction Discord interaction object
 */
async function handleInteraction(interaction) {
    try {
        if (interaction.isModalSubmit()) {
            return handleModalSubmit(interaction)
        }

        if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) {
            return
        }

        const command = client.commands.get(interaction.commandName)
        if (!command) {
            logger.warn(`⚠️ Unknown command: ${interaction.commandName}`)
            return
        }

        if (interaction.isChatInputCommand()) {
            const subcommand = interaction.options.getSubcommand(false)
            logger.info(`🎯 Executing command: /${interaction.commandName}${subcommand ? ` ${subcommand}` : ""}`)
            await command.execute(interaction)
        } else if (interaction.isAutocomplete() && command.autocomplete) {
            await command.autocomplete(interaction)
        }
    } catch (err) {
        logger.error(`❌ Error executing command /${interaction.commandName}:`, err)

        try {
            const errorResponse = {
                content: "❌ An error occurred while executing the command.",
                flags: [MessageFlags.Ephemeral]
            }

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply(errorResponse)
            } else {
                await interaction.editReply(errorResponse)
            }
        } catch (replyErr) {
            logger.error("❌ Failed to send error response:", replyErr)
        }
    }
}

// Set up bot event handlers
client.once(Events.ClientReady, () => {
    logger.info(`🤖 Discord bot logged in as ${client.user.tag}`)
})

// Initialize status updater
const startStatusUpdater = require("./statusUpdater")
client.once(Events.ClientReady, () => {
    startStatusUpdater(client)
})

// Handle interactions
client.on(Events.InteractionCreate, handleInteraction)

/**
 * Initialize and start the Discord bot
 * @returns {Promise<void>}
 */
async function startDiscordBot() {
    try {
        // Load command modules
        await loadCommands()

        // Deploy commands if needed
        await deployCommandsIfNeeded()

        // Log in to Discord
        await client.login(config.discord.botToken)
    } catch (err) {
        logger.error("❌ Failed to start Discord bot:", err)
        throw err
    }
}

module.exports = startDiscordBot
