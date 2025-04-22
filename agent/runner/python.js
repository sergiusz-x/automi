/**
 * Python Script Runner
 * Executes Python code with parameter injection and error handling
 */
const { spawn, execSync } = require("child_process")
const logger = require("../utils/logger")
const os = require("os")

/**
 * Find available Python interpreter
 * @returns {string} Name or path of the Python interpreter
 */
function findPythonInterpreter() {
    const pythonCommands = ["python", "python3", "py"]

    // Add potential Windows Python paths
    if (os.platform() === "win32") {
        pythonCommands.push(
            "C:\\Python39\\python.exe",
            "C:\\Python310\\python.exe",
            "C:\\Python311\\python.exe",
            "C:\\Python312\\python.exe",
            "%LOCALAPPDATA%\\Programs\\Python\\Python39\\python.exe",
            "%LOCALAPPDATA%\\Programs\\Python\\Python310\\python.exe",
            "%LOCALAPPDATA%\\Programs\\Python\\Python311\\python.exe",
            "%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe"
        )
    }

    for (const cmd of pythonCommands) {
        try {
            // Try to execute Python with version flag
            execSync(`${cmd} --version`, { stdio: "pipe" })
            logger.debug(`✅ Found Python interpreter: ${cmd}`)
            return cmd
        } catch (err) {
            // This command failed, try the next one
            continue
        }
    }

    logger.warn("⚠️ Could not find Python interpreter! Using 'python' as fallback")
    return "python" // Fallback to python, will likely fail but keeps existing behavior
}

// Get the Python interpreter once at module load time
const PYTHON_INTERPRETER = findPythonInterpreter()

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
 * Create a Python process to execute code
 * @param {string} script Python code to execute
 * @param {Object} params Parameters to inject into script
 * @param {Object} assets Global assets to inject into script
 * @returns {Promise<Object>} Process handle and result promise
 */
function createProcess(script, params = {}, assets = {}) {
    return new Promise(resolve => {
        try {
            // Set up Python process with environment variables
            const env = generateEnvironment(params, assets)
            logger.info(`🐍 Starting Python script execution with interpreter: ${PYTHON_INTERPRETER}`)

            const proc = spawn(PYTHON_INTERPRETER, ["-c", script], {
                timeout: 900000, // 15-minute timeout
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
                    stderr: "Process timed out after 15 minutes"
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
 * @param {Object} assets Global assets to inject into script
 * @returns {Promise<Object>} Object containing resultPromise and kill method
 */
async function run(script, params = {}, assets = {}) {
    try {
        // Store process reference outside the promise
        let processRef = null
        let isKilled = false

        // Start the process and get a reference to it
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
                        logger.info("🔪 Cancelling python process using direct reference")
                        return processRef.kill()
                    }

                    // If the process hasn't been created yet, wait up to 2 seconds
                    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 2000))
                    const proc = await Promise.race([processPromise, timeoutPromise])

                    if (proc && typeof proc.kill === "function") {
                        logger.info("🔪 Cancelling python process after waiting")
                        return proc.kill()
                    }

                    logger.warn("⚠️ Could not find python process to cancel")
                    return false
                } catch (err) {
                    logger.error(`❌ Error killing python process: ${err.message}`)
                    return false
                }
            }
        }
    } catch (err) {
        logger.error("❌ Unhandled exception in python runner:", err)
        return {
            resultPromise: Promise.resolve({
                success: false,
                code: 1,
                stdout: "",
                stderr: `Unhandled exception in python runner: ${err.toString()}`
            }),
            kill: () => false
        }
    }
}

module.exports = { run, createProcess }
