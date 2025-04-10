/**
 * TaskRun Database Model
 * Represents a single execution instance of a task
 */
const { DataTypes } = require("sequelize")
const logger = require("../../utils/logger")

/**
 * @typedef {Object} TaskRun
 * @property {number} taskId - Reference to the executed task
 * @property {string} agentId - ID of the agent that ran the task
 * @property {('pending'|'running'|'success'|'error'|'cancelled')} status - Execution result
 * @property {number} exitCode - Process exit code
 * @property {string} stdout - Standard output from execution 
 * @property {string} stderr - Error output from execution
 * @property {number} durationMs - Execution time in milliseconds
 * @property {Date} startedAt - Start time of the execution
 */
module.exports = sequelize => {
    const TaskRun = sequelize.define(
        "TaskRun",
        {
            taskId: {
                type: DataTypes.INTEGER,
                allowNull: true,
                references: {
                    model: "tasks",
                    key: "id"
                },
                validate: {
                    isInt: {
                        msg: "Task ID must be an integer"
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
            status: {
                type: DataTypes.ENUM("pending", "running", "success", "error", "cancelled"),
                allowNull: false,
                defaultValue: "pending",
                validate: {
                    isIn: {
                        args: [["pending", "running", "success", "error", "cancelled"]],
                        msg: "Status must be one of: pending, running, success, error, cancelled"
                    }
                }
            },
            exitCode: {
                type: DataTypes.INTEGER,
                allowNull: true,
                validate: {
                    isInt: {
                        msg: "Exit code must be an integer"
                    }
                }
            },
            stdout: {
                type: DataTypes.TEXT("long"),
                allowNull: true
            },
            stderr: {
                type: DataTypes.TEXT("long"),
                allowNull: true
            },
            durationMs: {
                type: DataTypes.INTEGER,
                allowNull: true,
                validate: {
                    isInt: {
                        msg: "Duration must be an integer"
                    },
                    min: {
                        args: [0],
                        msg: "Duration cannot be negative"
                    }
                }
            },
            startedAt: {
                type: DataTypes.DATE,
                allowNull: true
            }
        },
        {
            tableName: "task_runs",
            hooks: {
                beforeValidate: (run) => {
                    logger.debug(`🔍 Validating task run for task ${run.taskId}`)
                },
                beforeCreate: (run) => {
                    logger.debug(`📝 Recording execution for task ${run.taskId}`)
                },
                afterCreate: (run) => {
                    const status = {
                        pending: "⏳",
                        running: "⚙️",
                        success: "✅",
                        error: "❌",
                        cancelled: "🚫"
                    }[run.status]
                    const duration = run.durationMs !== undefined ? `${run.durationMs}ms` : "pending"
                    logger.info(
                        `${status} Task ${run.taskId} execution recorded - Agent: ${run.agentId}, Duration: ${duration}`
                    )
                },
                beforeDestroy: (run) => {
                    logger.warn(`🗑️ Deleting execution record for task ${run.taskId}`)
                },
                afterDestroy: (run) => {
                    logger.info(`✅ Execution record deleted for task ${run.taskId}`)
                }
            },
            indexes: [
                {
                    fields: ["taskId"],
                    name: "task_runs_task_id"
                },
                {
                    fields: ["agentId"],
                    name: "task_runs_agent_id"
                },
                {
                    fields: ["status"],
                    name: "task_runs_status"
                }
            ]
        }
    )

    return TaskRun
}
