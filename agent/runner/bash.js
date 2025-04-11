/**
 * Bash Script Runner
 * Executes shell scripts with parameter injection and security measures
 */
const { spawn } = require("child_process")
const logger = require("../utils/logger")
const os = require("os")
const path = require("path")

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
 * Find Git Bash installation on Windows
 * @returns {Promise<string>} Path to Git Bash executable
 */
async function findGitBash() {
    const commonPaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
        path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
    ]

    for (const path of commonPaths) {
        try {
            require("fs").accessSync(path)
            return path
        } catch (err) {
            continue
        }
    }

    // Try to find git in PATH
    try {
        const { execSync } = require("child_process")
        const gitPath = execSync("where git").toString().trim().split("\n")[0]
        if (gitPath) {
            return path.join(path.dirname(path.dirname(gitPath)), "bin", "bash.exe")
        }
    } catch (err) {
        // Ignore errors
    }

    return null
}

/**
 * Create a shell process to execute a script
 * @param {string} script Shell script to execute
 * @param {Object} params Parameters to inject as environment variables
 * @returns {Promise<Object>} Process handle and result promise
 */
async function createProcess(script, params = {}) {
    return new Promise(async resolve => {
        try {
            // Set up environment with parameters
            const env = generateEnvironment(params)

            // Determine which shell to use based on OS
            let shell,
                shellArgs,
                useShell = true
            if (os.platform() === "win32") {
                const gitBash = await findGitBash()
                if (gitBash) {
                    shell = gitBash
                    shellArgs = ["--login", "-c", script]
                    useShell = false // Don't use shell when using Git Bash directly
                } else {
                    shell = "cmd.exe"
                    shellArgs = ["/c", script]
                }
            } else {
                shell = "/bin/bash"
                shellArgs = ["--restricted", "--noprofile", "--norc", "-c", script]
            }

            logger.info(`🐚 Using shell: ${shell}`)

            // Set up shell process
            const proc = spawn(shell, shellArgs, {
                env,
                shell: useShell,
                timeout: 300000, // 5-minute timeout
                killSignal: "SIGTERM"
            })

            let stdout = ""
            let stderr = ""
            let hasError = false
            let killed = false

            // Handle standard output
            proc.stdout.on("data", data => {
                const output = data.toString()
                stdout += output
                logger.debug("📤 Shell stdout:", output.trim())
            })

            // Handle error output
            proc.stderr.on("data", data => {
                const error = data.toString()
                stderr += error
                hasError = true
                logger.warn("⚠️ Shell stderr:", error.trim())
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
                logger.error("⏱️ Script execution timed out")
                killed = true
                proc.kill("SIGTERM")
                resolve({
                    success: false,
                    code: 124,
                    stdout: stdout.trim(),
                    stderr: "Process timed out after 5 minutes"
                })
            })

            // Enhance kill method for clean termination
            proc.kill = () => {
                killed = true
                proc.kill("SIGTERM")
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
 * Execute a shell script with parameters
 * @param {string} script Shell script to execute
 * @param {Object} params Parameters to inject as environment variables
 * @returns {Promise<Object>} Execution results
 */
async function run(script, params = {}) {
    return createProcess(script, params)
}

module.exports = { run, createProcess }
