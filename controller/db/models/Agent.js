/**
 * Agent Database Model
 * Represents a remote execution agent in the system
 */
const { DataTypes } = require("sequelize")
const logger = require("../../utils/logger")

/**
 * @typedef {Object} Agent
 * @property {string} agentId - Unique agent identifier
 * @property {string} token - Authentication token
 * @property {string[]} ipWhitelist - List of allowed IP addresses
 * @property {Date} lastSeen - Last connection timestamp
 * @property {('online'|'offline')} status - Current connection status
 */
module.exports = sequelize => {
    const Agent = sequelize.define(
        "Agent",
        {
            agentId: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: {
                    msg: "This agent ID is already in use"
                },
                validate: {
                    notEmpty: {
                        msg: "Agent ID cannot be empty"
                    },
                    len: {
                        args: [3, 50],
                        msg: "Agent ID must be between 3 and 50 characters"
                    }
                }
            },
            token: {
                type: DataTypes.STRING,
                allowNull: false,
                validate: {
                    notEmpty: {
                        msg: "Authentication token cannot be empty"
                    },
                    len: {
                        args: [8, 100],
                        msg: "Token must be between 8 and 100 characters"
                    }
                }
            },
            ipWhitelist: {
                type: DataTypes.JSON,
                allowNull: false,
                defaultValue: ["*"],
                validate: {
                    isArray(value) {
                        if (!Array.isArray(value)) {
                            throw new Error("IP whitelist must be an array")
                        }
                    },
                    validateIPs(value) {
                        if (!Array.isArray(value)) return
                        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
                        const ipv6Regex =
                            /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|::1|::([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4})$/

                        for (const ip of value) {
                            if (ip === "*") continue
                            if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
                                throw new Error(`Invalid IP address: ${ip}`)
                            }
                        }
                    }
                }
            },
            lastSeen: {
                type: DataTypes.DATE,
                allowNull: true,
                validate: {
                    isDate: {
                        msg: "Last seen must be a valid date"
                    },
                    notInFuture(value) {
                        if (value && value > new Date()) {
                            throw new Error("Last seen cannot be in the future")
                        }
                    }
                }
            },
            status: {
                type: DataTypes.STRING,
                allowNull: false,
                defaultValue: "offline",
                validate: {
                    isIn: {
                        args: [["online", "offline"]],
                        msg: "Status must be either 'online' or 'offline'"
                    }
                }
            }
        },
        {
            tableName: "agents",
            hooks: {
                beforeValidate: agent => {
                    logger.debug(`🔍 Validating agent: ${agent.agentId}`)
                },
                beforeCreate: agent => {
                    logger.info(`📝 Registering new agent: ${agent.agentId}`)
                },
                afterCreate: agent => {
                    logger.info(`✅ Agent registered: ${agent.agentId}`)
                    logger.debug(`🔑 Security: IP whitelist set to [${agent.ipWhitelist.join(", ")}]`)
                },
                beforeUpdate: agent => {
                    if (agent.changed("status")) {
                        const newStatus = agent.status
                        const emoji = newStatus === "online" ? "🟢" : "🔴"
                        logger.info(`${emoji} Agent ${agent.agentId} status changing to: ${newStatus}`)
                    }
                    if (agent.changed("lastSeen")) {
                        logger.debug(`🕒 Agent ${agent.agentId} last seen updated`)
                    }
                    if (agent.changed("ipWhitelist")) {
                        logger.info(`🔒 Agent ${agent.agentId} IP whitelist updated`)
                    }
                },
                afterUpdate: agent => {
                    logger.debug(`✅ Agent ${agent.agentId} updated`)
                },
                beforeDestroy: agent => {
                    logger.warn(`🗑️ Removing agent: ${agent.agentId}`)
                },
                afterDestroy: agent => {
                    logger.info(`✅ Agent removed: ${agent.agentId}`)
                }
            },
            indexes: [
                {
                    fields: ["status"],
                    name: "agents_status"
                },
                {
                    fields: ["lastSeen"],
                    name: "agents_last_seen"
                }
            ]
        }
    )

    return Agent
}
