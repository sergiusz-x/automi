/**
 * Bash Script Runner
 * Executes shell scripts with parameter injection and security measures
 */
const { spawn } = require("child_process")
const logger = require("../utils/logger")
const os = require("os")
const path = require("path")
const fs = require("fs").promises

/**
 * Convert parameters to environment variables
 * @param {Object} params Parameters to inject
 * @param {Object} assets Global assets to inject
 * @returns {Object} Environment variables object
 */
function generateEnvironment(params, assets = {}) {
    const env = { ...process.env }

    // Validate input
    if (!params || typeof params !== "object") {
        logger.warn("⚠️ Invalid params provided to generateEnvironment, using empty params")
        return env
    }

    try {
        // Process regular parameters
        Object.entries(params).forEach(([key, value]) => {
            // Validate key
            if (!key || typeof key !== "string") {
                logger.warn(`⚠️ Invalid parameter key: ${key}, skipping`)
                return
            }

            // Convert all values to strings since env vars must be strings
            try {
                env[`PARAM_${key.toUpperCase()}`] = typeof value === "object" ? JSON.stringify(value) : String(value)
            } catch (valueErr) {
                logger.warn(`⚠️ Could not convert value for key ${key} to string, using empty string`, valueErr)
                env[`PARAM_${key.toUpperCase()}`] = ""
            }
        })

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

        logger.debug(
            "🔄 Generated parameter environment variables:",
            Object.keys(params).map(k => `PARAM_${k.toUpperCase()}`)
        )
    } catch (err) {
        logger.error("❌ Failed to convert parameters to env vars:", err)
    }
    return env
}

/**
 * Find Git Bash installation on Windows
 * @returns {Promise<string>} Path to Git Bash executable
 */
async function findGitBash() {
    const commonPaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        path.join(process.env.ProgramFiles || "", "Git", "bin", "bash.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "", "Git", "bin", "bash.exe")
    ]

    // Check for file existence using fs.promises for better error handling
    for (const bashPath of commonPaths) {
        try {
            await fs.access(bashPath)
            return bashPath
        } catch (err) {
            // Path doesn't exist, try next one
            continue
        }
    }

    // Try to find git in PATH
    try {
        const { execSync } = require("child_process")
        const gitPath = execSync("where git", { timeout: 5000 }).toString().trim().split("\n")[0]
        if (gitPath) {
            const bashPath = path.join(path.dirname(path.dirname(gitPath)), "bin", "bash.exe")
            try {
                await fs.access(bashPath)
                return bashPath
            } catch (accessErr) {
                logger.debug(`Found git at ${gitPath} but could not access bash at ${bashPath}`)
            }
        }
    } catch (err) {
        logger.debug("Could not find Git in PATH:", err.message)
    }

    logger.warn("⚠️ Could not find Git Bash, falling back to cmd.exe")
    return null
}

/**
 * Create a shell process to execute a script
 * @param {string} script Shell script to execute
 * @param {Object} params Parameters to inject as environment variables
 * @param {Object} assets Global assets to inject as environment variables
 * @returns {Promise<Object>} Process handle and result promise
 */
async function createProcess(script, params = {}, assets = {}) {
    // Validate script input
    if (!script || typeof script !== "string") {
        return Promise.resolve({
            success: false,
            code: 1,
            stdout: "",
            stderr: "Invalid script provided: must be a non-empty string"
        })
    }

    // Ensure script is not empty to prevent "-c: option requires an argument" error
    if (script.trim() === "") {
        script = 'echo "Warning: Empty script content provided"'
        logger.warn("⚠️ Empty script content provided, using default echo command")
    }

    return new Promise(async resolve => {
        let proc = null

        try {
            // Set up environment with parameters and assets
            const env = generateEnvironment(params, assets)

            // Determine which shell to use based on OS
            let shell,
                shellArgs,
                useShell = true

            if (os.platform() === "win32") {
                try {
                    const gitBash = await findGitBash()
                    if (gitBash) {
                        shell = gitBash
                        shellArgs = ["--login", "-c", script]
                        useShell = false // Don't use shell when using Git Bash directly
                    } else {
                        shell = "cmd.exe"
                        shellArgs = ["/c", script]
                    }
                } catch (shellErr) {
                    logger.error("❌ Error determining shell:", shellErr)
                    shell = "cmd.exe"
                    shellArgs = ["/c", script]
                }
            } else {
                shell = "/bin/bash"

                // Check if BASH_RESTRICTED asset is explicitly set to false
                const useRestrictedMode = assets?.BASH_RESTRICTED != false && assets?.bash_restricted != false

                if (useRestrictedMode) {
                    shellArgs = ["--restricted", "--noprofile", "--norc", "-c", script]
                    logger.debug("🔒 Using restricted mode for bash (BASH_RESTRICTED not set to false)")
                } else {
                    shellArgs = ["--noprofile", "--norc", "-c", script]
                    logger.debug("🔓 Using unrestricted mode for bash (BASH_RESTRICTED set to false)")
                }
            }

            logger.info(`🐚 Using shell: ${shell}`)

            // Set up shell process
            try {
                proc = spawn(shell, shellArgs, {
                    env,
                    shell: useShell,
                    timeout: 300000, // 5-minute timeout
                    killSignal: "SIGTERM"
                })
            } catch (spawnErr) {
                logger.error("❌ Failed to spawn process:", spawnErr)
                return resolve({
                    success: false,
                    code: 1,
                    stdout: "",
                    stderr: `Failed to spawn process: ${spawnErr.message}`
                })
            }

            let stdout = ""
            let stderr = ""
            let hasError = false
            let killed = false

            // Handle standard output
            proc.stdout.on("data", data => {
                try {
                    const output = data.toString()
                    stdout += output
                    logger.debug("📤 Shell stdout:", output.trim())
                } catch (stdoutErr) {
                    logger.warn("⚠️ Error processing stdout data:", stdoutErr)
                }
            })

            // Handle error output
            proc.stderr.on("data", data => {
                try {
                    const error = data.toString()
                    stderr += error
                    hasError = true
                    logger.warn("⚠️ Shell stderr:", error.trim())
                } catch (stderrErr) {
                    logger.warn("⚠️ Error processing stderr data:", stderrErr)
                }
            })

            // Handle process completion
            proc.on("close", code => {
                const success = code === 0 && !hasError && !killed
                logger.info(`${success ? "✅" : "❌"} Script finished with code ${code}, success: ${success}`)

                if (code !== 0) {
                    logger.error(`❌ Process exited with non-zero code ${code}`)
                }

                resolve({
                    success,
                    code: code !== null ? code : 1, // Ensure we don't pass null codes
                    stdout: stdout.trim(),
                    stderr: stderr.trim()
                })
            })

            // Handle process errors
            proc.on("error", err => {
                logger.error("❌ Failed to start or run process:", err)
                resolve({
                    success: false,
                    code: 1,
                    stdout: stdout.trim(),
                    stderr: `${stderr.trim()}\nProcess error: ${err.message}`
                })
            })

            // Handle timeout
            proc.on("timeout", () => {
                logger.error("⏱️ Script execution timed out")
                killed = true
                try {
                    proc.kill("SIGTERM")
                } catch (killErr) {
                    logger.error("❌ Error killing process after timeout:", killErr)
                }
                resolve({
                    success: false,
                    code: 124,
                    stdout: stdout.trim(),
                    stderr: `${stderr.trim()}\nProcess timed out after 5 minutes`
                })
            })

            // Set process exit handler to catch unexpected exits
            process.once("exit", () => {
                if (proc && !proc.killed) {
                    try {
                        proc.kill("SIGTERM")
                    } catch (e) {
                        // Ignore errors during shutdown
                    }
                }
            })

            // Enhance kill method for clean termination
            proc.kill = (signal = "SIGTERM") => {
                killed = true
                try {
                    return process.kill(proc.pid, signal)
                } catch (killErr) {
                    logger.error(`❌ Error killing process with signal ${signal}:`, killErr)
                    return false
                }
            }
        } catch (err) {
            logger.error("❌ Critical error in script execution:", err)
            resolve({
                success: false,
                code: 1,
                stdout: "",
                stderr: `Critical error in script execution: ${err.toString()}`
            })
        }
    })
}

/**
 * Execute a shell script with parameters
 * @param {string} script Shell script to execute
 * @param {Object} params Parameters to inject as environment variables
 * @param {Object} assets Global assets to inject as environment variables
 * @returns {Promise<Object>} Execution results
 */
async function run(script, params = {}, assets = {}) {
    try {
        return await createProcess(script, params, assets)
    } catch (err) {
        logger.error("❌ Unhandled exception in bash runner:", err)
        return {
            success: false,
            code: 1,
            stdout: "",
            stderr: `Unhandled exception in bash runner: ${err.toString()}`
        }
    }
}

module.exports = { run, createProcess }
