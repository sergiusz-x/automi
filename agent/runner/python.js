/**
 * Python Script Runner
 * Executes Python code with parameter injection and error handling
 */
const { spawn } = require("child_process")
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
 * Create a Python process to execute code
 * @param {string} script Python code to execute
 * @param {Object} params Parameters to inject into script
 * @returns {Promise<Object>} Process handle and result promise
 */
function createProcess(script, params = {}) {
    return new Promise(resolve => {
        try {
            // Set up Python process with environment variables
            const env = generateEnvironment(params)
            logger.info("🐍 Starting Python script execution")

            const proc = spawn("python", ["-c", script], {
                timeout: 300000, // 5-minute timeout
                env
            })

            let stdout = ""
            let stderr = ""
            let hasError = false
            let killed = false

            // Handle standard output
            proc.stdout.on("data", data => {
                const output = data.toString()
                stdout += output
                logger.debug("📤 Python stdout:", output.trim())
            })

            // Handle error output
            proc.stderr.on("data", data => {
                const error = data.toString()
                stderr += error
                hasError = true
                logger.warn("⚠️ Python stderr:", error.trim())
            })

            // Handle process completion
            proc.on("close", code => {
                const success = code === 0 && !hasError && !killed
                logger.info(`${success ? "✅" : "❌"} Python script finished with code ${code}, success: ${success}`)

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
            proc.on("error", err => {
                logger.error("❌ Failed to start process:", err)
                resolve({
                    success: false,
                    code: 1,
                    stdout: "",
                    stderr: err.message
                })
            })

            // Handle timeout
            proc.on("timeout", () => {
                killed = true
                proc.kill("SIGTERM")
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

            return proc
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
 * Execute Python code with parameters
 * @param {string} script Python code to execute
 * @param {Object} params Parameters to inject into script
 * @returns {Promise<Object>} Execution results
 */
async function run(script, params = {}) {
    return createProcess(script, params)
}

module.exports = { run, createProcess }
