/**
 * Asset Database Model
 * Represents a global asset that can be used by all agents
 */
const { DataTypes } = require("sequelize")
const logger = require("../../utils/logger")

/**
 * @typedef {Object} Asset
 * @property {string} key - Unique asset key
 * @property {string} value - Asset value
 * @property {string} description - Optional description of the asset
 */
module.exports = sequelize => {
    const Asset = sequelize.define(
        "Asset",
        {
            key: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: {
                    msg: "This asset key is already in use"
                },
                validate: {
                    notEmpty: {
                        msg: "Asset key cannot be empty"
                    },
                    len: {
                        args: [1, 50],
                        msg: "Asset key must be between 1 and 50 characters"
                    }
                }
            },
            value: {
                type: DataTypes.TEXT,
                allowNull: false,
                defaultValue: "",
                validate: {
                    notNull: {
                        msg: "Asset value is required"
                    }
                }
            },
            description: {
                type: DataTypes.TEXT,
                allowNull: true
            }
        },
        {
            tableName: "assets",
            hooks: {
                beforeValidate: asset => {
                    logger.debug(`🔍 Validating asset: ${asset.key}`)
                },
                beforeCreate: asset => {
                    logger.info(`📝 Creating new asset: ${asset.key}`)
                },
                afterCreate: asset => {
                    logger.info(`✅ Asset created: ${asset.key}`)
                },
                beforeUpdate: asset => {
                    if (asset.changed("value")) {
                        logger.debug(`📝 Updating value for asset: ${asset.key}`)
                    }
                    if (asset.changed("description")) {
                        logger.debug(`📝 Updating description for asset: ${asset.key}`)
                    }
                },
                afterUpdate: asset => {
                    logger.info(`✅ Asset updated: ${asset.key}`)
                },
                beforeDestroy: asset => {
                    logger.warn(`🗑️ Removing asset: ${asset.key}`)
                },
                afterDestroy: asset => {
                    logger.info(`✅ Asset removed: ${asset.key}`)
                }
            },
            indexes: [
                {
                    fields: ["key"],
                    name: "assets_key",
                    unique: true
                }
            ]
        }
    )

    return Asset
}
