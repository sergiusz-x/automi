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
 * @returns {Object} Environment variables object
 */
function generateEnvironment(params) {
    const env = { ...process.env }
    try {
        Object.entries(params).forEach(([key, value]) => {
            // Convert all values to strings since env vars must be strings
            env[`PARAM_${key.toUpperCase()}`] = typeof value === "object" ? JSON.stringify(value) : String(value)
        })
        logger.debug(
            "🔄 Generated environment variables:",
            Object.keys(params).map(k => `PARAM_${k.toUpperCase()}`)
        )
    } catch (err) {
        logger.error("❌ Failed to convert parameters to env vars:", err)
    }
    return env
}

/**
 * Create a Node.js process to execute a script
 * @param {string} script Node.js code to execute
 * @param {Object} params Parameters to inject as environment variables
 * @returns {Promise<Object>} Process handle and result promise
 */
async function createProcess(script, params = {}) {
    return new Promise(async resolve => {
        try {
            // Create temporary script file
            const tmpDir = os.tmpdir()
            const tmpFile = path.join(tmpDir, `script-${Date.now()}.js`)

            // Set up environment with parameters
            const env = generateEnvironment(params)

            // Write script directly to temp file without additional wrapping
            await fs.writeFile(tmpFile, script, "utf8")
            logger.info(`📝 Created temporary script at: ${tmpFile}`)

            // Execute the script using node
            logger.info("🟢 Starting Node.js script execution")
            const proc = spawn("node", [tmpFile], {
                env,
                timeout: 300000 // 5-minute timeout
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
                    stderr: "Process timed out after 5 minutes"
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
 * @returns {Promise<Object>} Execution results
 */
async function run(script, params = {}) {
    return createProcess(script, params)
}

module.exports = { run, createProcess }
