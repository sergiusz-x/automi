/**
 * Database Connection and Model Management Module
 * Handles database initialization, model loading, and relationships
 */
const { Sequelize } = require("sequelize")
const fs = require("fs")
const path = require("path")
const config = require("../utils/config")
const logger = require("../utils/logger")

// Initialize Sequelize with database configuration
const sequelize = new Sequelize(
    config.database.name, 
    config.database.username, 
    config.database.password, 
    {
        host: config.database.host,
        port: config.database.port,
        dialect: "mysql",
        logging: msg => logger.debug("🛢️ SQL:", msg),
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    }
)

// Initialize database object
const db = { sequelize }

// Load all model definitions
const modelsDir = path.join(__dirname, "models")
logger.info("📚 Loading database models...")

fs.readdirSync(modelsDir)
    .filter(file => file.endsWith(".js"))
    .forEach(file => {
        logger.debug(`📝 Loading model from ${file}`)
        try {
            const model = require(path.join(modelsDir, file))(sequelize)
            db[model.name] = model
            logger.debug(`✅ Model ${model.name} loaded successfully`)
        } catch (err) {
            logger.error(`❌ Failed to load model from ${file}:`, err)
        }
    })

// Set up model relationships
logger.info("🔗 Setting up model relationships...")

// Link TaskRun to Task for execution tracking
if (db.TaskRun && db.Task) {
    db.TaskRun.belongsTo(db.Task, { 
        foreignKey: "taskId",
        onDelete: "SET NULL"
    })
    logger.debug("✅ TaskRun → Task relationship established")
}

// Set up relationships
if (db.Task && db.TaskDependency) {
    db.Task.hasMany(db.TaskDependency, {
        foreignKey: 'parentTaskId',
        as: 'childDependencies'
    })

    db.Task.hasMany(db.TaskDependency, {
        foreignKey: 'childTaskId',
        as: 'parentDependencies'
    })

    db.TaskDependency.belongsTo(db.Task, {
        foreignKey: 'parentTaskId',
        as: 'parentTask'
    })

    db.TaskDependency.belongsTo(db.Task, {
        foreignKey: 'childTaskId',
        as: 'childTask'
    })
    logger.debug("✅ Task and TaskDependency relationships established")
}

// Export database connection and models
db.sequelize = sequelize
db.Sequelize = Sequelize

module.exports = db
