/**
 * Database Connection and Model Management Module
 * Handles database initialization, model loading, and relationships
 */
const { Sequelize } = require("sequelize")
const fs = require("fs")
const path = require("path")
const config = require("../utils/config")
const logger = require("../utils/logger")

// Validate database configuration before attempting connection
const dbConfig = config.database || {}
if (!dbConfig.name || !dbConfig.username || !dbConfig.host) {
    logger.error("❌ Invalid database configuration - missing required fields")
    // We don't throw here to allow the application to initialize
    // The connection attempt will fail and be handled gracefully
}

// Initialize Sequelize with database configuration - simplified configuration
const sequelize = new Sequelize(dbConfig.name, dbConfig.username, dbConfig.password, {
    host: dbConfig.host,
    port: dbConfig.port,
    dialect: "mysql",
    logging: msg => logger.debug("🛢️ SQL:", msg),
    pool: {
        max: 10,
        min: 0,
        acquire: 30000,
        idle: 10000
    },
    // Better error handling for connections
    dialectOptions: {
        connectTimeout: 20000 // 20 second timeout for initial connection
    }
})

// Initialize database object
const db = { sequelize, isConnected: false }

/**
 * Attempt to connect to the database with retries
 * @param {number} retries - Number of retries left
 * @param {number} delay - Delay between retries in ms
 * @returns {Promise<boolean>} - Whether connection was successful
 */
db.connect = async function (retries = 5, delay = 5000) {
    let attempt = 0

    while (attempt <= retries) {
        try {
            if (attempt > 0) {
                logger.info(`🔄 Database connection attempt ${attempt}/${retries}...`)
            }

            await sequelize.authenticate()
            db.isConnected = true
            logger.info("✅ Database connection established successfully")
            return true
        } catch (err) {
            attempt++

            if (attempt > retries) {
                logger.error("❌ Failed to connect to database after maximum retries:", err)
                return false
            }

            logger.warn(`⚠️ Database connection failed (attempt ${attempt}/${retries}): ${err.message}`)
            logger.info(`⏱️ Retrying in ${delay / 1000} seconds...`)

            // Wait before next attempt - using exponential backoff
            await new Promise(resolve => setTimeout(resolve, delay))
            delay = Math.min(delay * 1.5, 30000) // Exponential backoff, max 30 seconds
        }
    }

    return false
}

// Load all model definitions
const modelsDir = path.join(__dirname, "models")
logger.info("📚 Loading database models...")

try {
    const modelFiles = fs.readdirSync(modelsDir).filter(file => file.endsWith(".js"))

    if (modelFiles.length === 0) {
        logger.warn("⚠️ No model files found in models directory")
    }

    modelFiles.forEach(file => {
        logger.debug(`📝 Loading model from ${file}`)
        try {
            const model = require(path.join(modelsDir, file))(sequelize)
            db[model.name] = model
            logger.debug(`✅ Model ${model.name} loaded successfully`)
        } catch (err) {
            logger.error(`❌ Failed to load model from ${file}:`, err)
            // Don't throw here to allow loading other models
        }
    })
} catch (err) {
    logger.error("❌ Error loading models directory:", err)
}

// Set up model relationships
logger.info("🔗 Setting up model relationships...")

// Link TaskRun to Task for execution tracking
try {
    if (db.TaskRun && db.Task) {
        db.TaskRun.belongsTo(db.Task, {
            foreignKey: "taskId",
            onDelete: "SET NULL"
        })
        logger.debug("✅ TaskRun → Task relationship established")
    } else if (!db.TaskRun) {
        logger.warn("⚠️ TaskRun model not found, can't establish relationship")
    } else if (!db.Task) {
        logger.warn("⚠️ Task model not found, can't establish relationship")
    }

    // Set up relationships
    if (db.Task && db.TaskDependency) {
        db.Task.hasMany(db.TaskDependency, {
            foreignKey: "parentTaskId",
            as: "childDependencies"
        })

        db.Task.hasMany(db.TaskDependency, {
            foreignKey: "childTaskId",
            as: "parentDependencies"
        })

        db.TaskDependency.belongsTo(db.Task, {
            foreignKey: "parentTaskId",
            as: "parentTask"
        })

        db.TaskDependency.belongsTo(db.Task, {
            foreignKey: "childTaskId",
            as: "childTask"
        })
        logger.debug("✅ Task and TaskDependency relationships established")
    } else {
        if (!db.Task) logger.warn("⚠️ Task model not found, can't establish Task-TaskDependency relationships")
        if (!db.TaskDependency)
            logger.warn("⚠️ TaskDependency model not found, can't establish Task-TaskDependency relationships")
    }
} catch (err) {
    logger.error("❌ Error setting up model relationships:", err)
}

// Export database connection and models
db.sequelize = sequelize
db.Sequelize = Sequelize

module.exports = db
