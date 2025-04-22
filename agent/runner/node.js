/**
 * Node.js Script Runner
 * Executes Node.js scripts with parameter injection and error handling
 */
const { spawn } = require("child_process")
const fs = require("fs").promises
const path = require("path")
const os = require("os")
const logger = require("../utils/logger")

/**
 * Convert parameters to environment variables
 * @param {Object} params Parameters to inject
 * @param {Object} assets Global assets to inject
 * @returns {Object} Environment variables object
 */
function generateEnvironment(params, assets = {}) {
    const env = { ...process.env }
    try {
        // Process regular parameters
        Object.entries(params).forEach(([key, value]) => {
            // Convert all values to strings since env vars must be strings
            env[`PARAM_${key.toUpperCase()}`] = typeof value === "object" ? JSON.stringify(value) : String(value)
        })
        logger.debug(
            "🔄 Generated parameter environment variables:",
            Object.keys(params).map(k => `PARAM_${k.toUpperCase()}`)
        )

        // Process global assets
        if (assets && typeof assets === "object") {
            Object.entries(assets).forEach(([key, value]) => {
                if (!key || typeof key !== "string") {
                    logger.warn(`⚠️ Invalid asset key: ${key}, skipping`)
                    return
                }

                try {
                    env[`ASSET_${key.toUpperCase()}`] = String(value)
                } catch (valueErr) {
                    logger.warn(`⚠️ Could not convert asset ${key} to string, using empty string`, valueErr)
                    env[`ASSET_${key.toUpperCase()}`] = ""
                }
            })
            logger.debug(
                "🔑 Generated asset environment variables:",
                Object.keys(assets).map(k => `ASSET_${k.toUpperCase()}`)
            )
        }
    } catch (err) {
        logger.error("❌ Failed to convert parameters to env vars:", err)
    }
    return env
}

/**
 * Create a Node.js process to execute a script
 * @param {string} script Node.js code to execute
 * @param {Object} params Parameters to inject as environment variables
 * @param {Object} assets Global assets to inject as environment variables
 * @returns {Promise<Object>} Process handle and result promise
 */
async function createProcess(script, params = {}, assets = {}) {
    return new Promise(async resolve => {
        try {
            // Create temporary script file
            const tmpDir = os.tmpdir()
            const tmpFile = path.join(tmpDir, `script-${Date.now()}.js`)

            // Set up environment with parameters and assets
            const env = generateEnvironment(params, assets)

            // Write script directly to temp file without additional wrapping
            await fs.writeFile(tmpFile, script, "utf8")
            logger.info(`📝 Created temporary script at: ${tmpFile}`)

            // Execute the script using node
            logger.info("🟢 Starting Node.js script execution")
            const proc = spawn("node", [tmpFile], {
                env,
                timeout: 900000 // 15-minute timeout
            })

            let stdout = ""
            let stderr = ""
            let hasError = false
            let killed = false

            // Handle standard output
            proc.stdout.on("data", data => {
                const output = data.toString()
                stdout += output
                logger.debug("📤 Node.js stdout:", output.trim())
            })

            // Handle error output
            proc.stderr.on("data", data => {
                const error = data.toString()
                stderr += error
                hasError = true
                logger.warn("⚠️ Node.js stderr:", error.trim())
            })

            // Handle process completion
            proc.on("close", async code => {
                try {
                    // Clean up temp file
                    await fs.unlink(tmpFile)
                    logger.debug("🧹 Temporary script file removed")
                } catch (err) {
                    logger.warn("⚠️ Failed to clean up temp file:", err)
                }

                const success = code === 0 && !hasError && !killed
                logger.info(`${success ? "✅" : "❌"} Script finished with code ${code}, success: ${success}`)

                if (code !== 0) {
                    logger.error(`❌ Process exited with non-zero code ${code}`)
                }

                resolve({
                    success,
                    code,
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                })
            })

            // Handle process errors
            proc.on("error", async err => {
                try {
                    await fs.unlink(tmpFile)
                } catch (cleanupErr) {
                    logger.warn("⚠️ Failed to clean up temp file:", cleanupErr)
                }

                logger.error("❌ Failed to start process:", err)
                resolve({
                    success: false,
                    code: 1,
                    stdout: "",
                    stderr: err.message
                })
            })

            // Handle timeout
            proc.on("timeout", async () => {
                killed = true
                proc.kill("SIGTERM")

                try {
                    await fs.unlink(tmpFile)
                } catch (cleanupErr) {
                    logger.warn("⚠️ Failed to clean up temp file:", cleanupErr)
                }

                logger.error("⏱️ Script execution timed out")
                resolve({
                    success: false,
                    code: 124,
                    stdout: stdout.trim(),
                    stderr: "Process timed out after 15 minutes"
                })
            })

            // Enhance kill method for clean termination
            const originalKill = proc.kill
            proc.kill = () => {
                killed = true
                return originalKill.call(proc, "SIGTERM")
            }
        } catch (err) {
            logger.error("❌ Critical error in script execution:", err)
            resolve({
                success: false,
                code: 1,
                stdout: "",
                stderr: err.message
            })
        }
    })
}

/**
 * Execute a Node.js script with parameters
 * @param {string} script Node.js code to execute
 * @param {Object} params Parameters to inject as environment variables
 * @param {Object} assets Global assets to inject as environment variables
 * @returns {Promise<Object>} Object containing resultPromise and kill method
 */
async function run(script, params = {}, assets = {}) {
    try {
        // Store process reference outside the promise
        let processRef = null
        let isKilled = false

        // Create the process but don't wait for it to complete
        const processPromise = createProcess(script, params, assets).then(processObj => {
            // Save reference to the process, but only if it wasn't canceled before
            if (!isKilled) {
                processRef = processObj
            }
            return processObj
        })

        // Return both the promise and methods to control the process
        return {
            // The promise that will resolve with the final result
            resultPromise: processPromise,

            // Method to kill the process when cancel is requested
            async kill() {
                try {
                    isKilled = true

                    // If we already have a process reference, use it
                    if (processRef && typeof processRef.kill === "function") {
                        logger.info("🔪 Cancelling node.js process using direct reference")
                        return processRef.kill()
                    }

                    // If the process hasn't been created yet, wait up to 2 seconds
                    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 2000))
                    const proc = await Promise.race([processPromise, timeoutPromise])

                    if (proc && typeof proc.kill === "function") {
                        logger.info("🔪 Cancelling node.js process after waiting")
                        return proc.kill()
                    }

                    logger.warn("⚠️ Could not find node.js process to cancel")
                    return false
                } catch (err) {
                    logger.error(`❌ Error killing node.js process: ${err.message}`)
                    return false
                }
            }
        }
    } catch (err) {
        logger.error("❌ Unhandled exception in node.js runner:", err)
        return {
            resultPromise: Promise.resolve({
                success: false,
                code: 1,
                stdout: "",
                stderr: `Unhandled exception in node.js runner: ${err.toString()}`
            }),
            kill: () => false
        }
    }
}

module.exports = { run, createProcess }
