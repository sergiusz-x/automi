const { DataTypes } = require("sequelize")

module.exports = sequelize => {
    const TaskDependency = sequelize.define(
        "TaskDependency",
        {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true
            },
            parentTaskId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                validate: {
                    notNull: {
                        msg: "Parent task ID is required"
                    }
                }
            },
            childTaskId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                validate: {
                    notNull: {
                        msg: "Child task ID is required"
                    },
                    notEqualParent(value) {
                        if (value === this.parentTaskId) {
                            throw new Error("Task cannot depend on itself")
                        }
                    }
                }
            },
            condition: {
                type: DataTypes.ENUM("always", "on:success", "on:error"),
                allowNull: false,
                defaultValue: "always",
                validate: {
                    isIn: {
                        args: [["always", "on:success", "on:error"]],
                        msg: "Condition must be 'always', 'on:success', or 'on:error'"
                    }
                }
            },
            description: {
                type: DataTypes.STRING,
                allowNull: true
            }
        },
        {
            tableName: "task_dependencies",
            timestamps: true,
            indexes: [
                {
                    unique: true,
                    fields: ["parentTaskId", "childTaskId"],
                    name: "unique_task_dependency"
                },
                {
                    fields: ["parentTaskId"],
                    name: "idx_parent_task"
                },
                {
                    fields: ["childTaskId"],
                    name: "idx_child_task"
                }
            ],
            validate: {
            }
        }
    )

    TaskDependency.associate = models => {
        TaskDependency.belongsTo(models.Task, {
            foreignKey: "parentTaskId",
            as: "parentTask"
        })
        TaskDependency.belongsTo(models.Task, {
            foreignKey: "childTaskId",
            as: "childTask"
        })
    }

    return TaskDependency
}