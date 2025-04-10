/**
 * Task Database Model
 * Represents an automation task definition
 */
const { DataTypes } = require("sequelize")
const logger = require("../../utils/logger")
const cron = require("node-cron")

/**
 * @typedef {Object} Task
 * @property {string} name - Unique task identifier
 * @property {('bash'|'python'|'node')} type - Script execution type
 * @property {string} script - Script content to execute
 * @property {Object} params - Optional parameters for script execution
 * @property {string} agentId - ID of the agent to run the task
 * @property {string} schedule - Optional cron schedule expression
 * @property {boolean} enabled - Whether the task is active
 */
module.exports = sequelize => {
    const Task = sequelize.define(
        "Task",
        {
            name: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: {
                    msg: "Task name must be unique"
                },
                validate: {
                    notEmpty: {
                        msg: "Task name cannot be empty"
                    },
                    len: {
                        args: [3, 50],
                        msg: "Task name must be between 3 and 50 characters"
                    },
                    is: {
                        args: /^[a-zA-Z0-9-_]+$/,
                        msg: "Task name can only contain letters, numbers, hyphens, and underscores"
                    }
                }
            },
            type: {
                type: DataTypes.ENUM("bash", "python", "node"),
                allowNull: false,
                validate: {
                    isIn: {
                        args: [["bash", "python", "node"]],
                        msg: "Invalid script type"
                    }
                }
            },
            script: {
                type: DataTypes.TEXT("long"),
                allowNull: false,
                validate: {
                    notEmpty: {
                        msg: "Script content cannot be empty"
                    },
                    len: {
                        args: [1, 100000],
                        msg: "Script content must be between 1 and 100000 characters"
                    }
                }
            },
            params: {
                type: DataTypes.JSON,
                allowNull: true,
                defaultValue: {},
                get() {
                    const rawValue = this.getDataValue('params');
                    return rawValue ? (typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue) : {};
                },
                set(value) {
                    this.setDataValue('params', value ? (typeof value === 'string' ? JSON.parse(value) : value) : {});
                },
                validate: {
                    isObject(value) {
                        if (value && typeof value !== "object") {
                            throw new Error("Params must be an object")
                        }
                        if (Array.isArray(value)) {
                            throw new Error("Params cannot be an array")
                        }
                    }
                }
            },
            agentId: {
                type: DataTypes.STRING,
                allowNull: false,
                validate: {
                    notEmpty: {
                        msg: "Agent ID cannot be empty"
                    }
                }
            },
            schedule: {
                type: DataTypes.STRING,
                allowNull: true,
                validate: {
                    isCronExpression(value) {
                        if (value && !cron.validate(value)) {
                            throw new Error("Invalid cron expression")
                        }
                    }
                }
            },
            enabled: {
                type: DataTypes.BOOLEAN,
                allowNull: false,
                defaultValue: true
            }
        },
        {
            tableName: "tasks",
            hooks: {
                beforeValidate: (task) => {
                    logger.debug(`🔍 Validating task: ${task.name}`)
                },
                beforeCreate: (task) => {
                    logger.info(`📝 Creating new task: ${task.name}`)
                },
                afterCreate: (task) => {
                    logger.info(`✅ Task created: ${task.name}`)
                    if (task.schedule) {
                        logger.info(`⏰ Task scheduled: ${task.schedule}`)
                    }
                },
                beforeUpdate: (task) => {
                    if (task.changed("script")) {
                        logger.info(`📝 Updating script for task: ${task.name}`)
                    }
                    if (task.changed("schedule")) {
                        const newSchedule = task.schedule || "none"
                        logger.info(`⏰ Updating schedule for task ${task.name}: ${newSchedule}`)
                    }
                    if (task.changed("enabled")) {
                        const status = task.enabled ? "enabled" : "disabled"
                        logger.info(`🔄 Task ${task.name} ${status}`)
                    }
                },
                afterUpdate: (task) => {
                    logger.info(`✅ Task updated: ${task.name}`)
                },
                beforeDestroy: (task) => {
                    logger.warn(`🗑️ Removing task: ${task.name}`)
                },
                afterDestroy: (task) => {
                    logger.info(`✅ Task removed: ${task.name}`)
                }
            },
            indexes: [
                {
                    unique: true,
                    fields: ["name"],
                    name: "tasks_name"
                },
                {
                    fields: ["agentId"],
                    name: "tasks_agent_id"
                },
                {
                    fields: ["enabled"],
                    name: "tasks_enabled"
                }
            ]
        }
    )

    return Task
}
