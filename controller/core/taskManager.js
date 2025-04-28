const db = require("../db")
const logger = require("../utils/logger")
const { WebSocket } = require("ws")
const agentState = require("./agentState")
const { sendTaskResult } = require("../services/webhook")

// Define constants for task statuses
const TASK_STATUSES = {
    PENDING: "pending",
    RUNNING: "running",
    SUCCESS: "success",
    ERROR: "error",
    CANCELLED: "cancelled"
}

class TaskManager {
    constructor() {
        this.runningTasks = new Map()
        this.taskQueue = new Map()
    }

    /**
     * Initialize the task manager
     * Should be called after database tables are created
     */
    async initialize() {
        await this.syncRunningTasks()
    }

    /**
     * Synchronize running tasks with database state
     * @private
     */
    async syncRunningTasks() {
        // Find all tasks marked as running in DB
        const runningInDb = await db.TaskRun.findAll({
            where: { status: TASK_STATUSES.RUNNING },
            include: [
                {
                    model: db.Task,
                    attributes: ["id", "name", "agentId"]
                }
            ]
        })

        // Mark them as error since they were interrupted
        for (const run of runningInDb) {
            run.status = TASK_STATUSES.ERROR
            run.stderr = "Task interrupted by controller restart"
            await run.save()

            logger.warn(`⚠️ Marked interrupted task ${run.Task.name} as error`)
        }
    }

    /**
     * Get task dependencies
     * @param {string} taskId Task ID
     * @returns {Promise<Array>} Array of dependencies
     */
    async getTaskDependencies(taskId) {
        const dependencies = await db.TaskDependency.findAll({
            where: { childTaskId: taskId },
            include: [
                {
                    model: db.Task,
                    as: "parentTask",
                    attributes: ["id", "name", "agentId"]
                }
            ]
        })

        return dependencies.map(dep => ({
            taskId: dep.parentTask.id,
            condition: dep.condition || "always"
        }))
    }

    /**
     * Check if task dependencies are satisfied
     * @param {string} taskId Task ID
     * @returns {Promise<boolean>} Whether dependencies are satisfied
     */
    async checkDependencies(taskId) {
        const dependencies = await this.getTaskDependencies(taskId)

        for (const dep of dependencies) {
            const latestRun = await db.TaskRun.findOne({
                where: { taskId: dep.taskId },
                order: [["createdAt", "DESC"]]
            })

            if (!latestRun) return false

            switch (dep.condition) {
                case "on:success":
                    if (latestRun.status !== TASK_STATUSES.SUCCESS) return false
                    break
                case "on:error":
                    if (latestRun.status !== TASK_STATUSES.ERROR) return false
                    break
                // "always" condition is always satisfied if run exists
            }
        }

        return true
    }

    /**
     * Get downstream tasks that should run after a task
     * @param {string} taskId Task ID
     * @param {string} status Task status
     * @returns {Promise<Array>} Array of downstream tasks
     */
    async getDownstreamTasks(taskId, status) {
        const dependencies = await db.TaskDependency.findAll({
            where: { parentTaskId: taskId },
            include: [
                {
                    model: db.Task,
                    as: "childTask",
                    attributes: ["id", "name", "agentId", "type", "script", "params"]
                }
            ]
        })

        return dependencies
            .filter(dep => {
                const condition = dep.condition || "always"
                switch (condition) {
                    case "on:success":
                        return status === TASK_STATUSES.SUCCESS
                    case "on:error":
                        return status === TASK_STATUSES.ERROR
                    case "always":
                        return true
                    default:
                        return false
                }
            })
            .map(dep => dep.childTask)
    }

    /**
     * Queue a task for execution
     * @param {Object} task Task object
     * @param {Object} run TaskRun record
     * @param {Object} options Run options
     */
    async queueTask(task, run, options = {}) {
        try {
            const canRun = await this.checkDependencies(task.id)

            // If no run record provided, create one
            if (!run) {
                run = await db.TaskRun.create({
                    taskId: task.id,
                    agentId: task.agentId,
                    status: TASK_STATUSES.PENDING
                })
            }

            if (!canRun) {
                this.taskQueue.set(task.id, { task, run, options })
                return
            }

            if (agentState.isAgentOnline(task.agentId)) {
                await this.executeTask(task, run, options)
            } else {
                logger.warn(`⚠️ Agent ${task.agentId} offline, queuing task`)
                this.taskQueue.set(task.id, { task, run, options })
            }
        } catch (err) {
            logger.error(`❌ Error queuing task ${task.name}:`, err)
        }
    }

    /**
     * Executes a task based on its configuration and dependencies.
     * Handles retries and updates the task status.
     */
    async executeTask(task, run, options = {}) {
        try {
            // Get agent state directly from agentState
            const agent = agentState.getAgent(task.agentId)

            if (!agent?.wsConnection) {
                logger.error(`❌ No WebSocket connection for agent ${task.agentId}`)
                // Notify via webhook about offline agent error
                await sendTaskResult({
                    taskId: task.id,
                    taskName: task.name,
                    agentId: task.agentId,
                    status: TASK_STATUSES.ERROR,
                    stdout: "",
                    stderr: `Agent ${task.agentId} offline or not connected`,
                    exitCode: 1,
                    durationMs: 0
                })
                throw new Error(`Agent ${task.agentId} offline or not connected`)
            }

            if (agent.wsConnection.readyState !== WebSocket.OPEN) {
                logger.error(
                    `❌ WebSocket connection not open for agent ${task.agentId} (state: ${agent.wsConnection.readyState})`
                )
                // Notify via webhook about offline agent error
                await sendTaskResult({
                    taskId: task.id,
                    taskName: task.name,
                    agentId: task.agentId,
                    status: TASK_STATUSES.ERROR,
                    stdout: "",
                    stderr: `Agent ${task.agentId} connection not open (state: ${agent.wsConnection.readyState})`,
                    exitCode: 1,
                    durationMs: 0
                })
                throw new Error(`Agent ${task.agentId} connection not open (state: ${agent.wsConnection.readyState})`)
            }

            // Validate task data before sending to agent
            if (!task.id || !task.name || !task.type || task.script === undefined) {
                logger.error(`❌ Invalid task data for ${task.id || "unknown task"}: missing required properties`)
                throw new Error(`Invalid task data: missing required properties`)
            }

            // Fetch all global assets
            let assets = {}
            try {
                const assetRecords = await db.Asset.findAll()
                assets = assetRecords.reduce((acc, asset) => {
                    acc[asset.key] = asset.value
                    return acc
                }, {})
                logger.debug(`🔑 Loaded ${assetRecords.length} assets for task execution`)
            } catch (assetErr) {
                logger.warn(`⚠️ Failed to load global assets: ${assetErr.message}`)
                // Continue execution without assets
            }

            // Start transaction for status update with retry logic
            let retries = 3
            let success = false
            let lastError = null

            while (retries > 0 && !success) {
                try {
                    await db.sequelize.transaction(async t => {
                        run.status = TASK_STATUSES.RUNNING
                        run.startedAt = new Date()
                        await run.save({ transaction: t })
                    })
                    success = true
                } catch (err) {
                    lastError = err
                    retries--

                    if (retries === 0) {
                        throw err
                    }

                    // Wait before retry with exponential backoff
                    const delay = Math.pow(2, 3 - retries) * 500
                    logger.warn(`⚠️ Database error updating task status, retrying in ${delay}ms: ${err.message}`)
                    await new Promise(resolve => setTimeout(resolve, delay))
                }
            }

            const message = {
                type: "EXECUTE_TASK",
                payload: {
                    taskId: task.id,
                    runId: run.id,
                    name: task.name,
                    type: task.type,
                    script: task.script,
                    // Merge base params from task with override params from options
                    params: { ...(task.params || {}), ...(options.params || {}) },
                    assets, // Add assets to the message payload
                    options
                }
            }

            // Send message to agent with timeout handling
            try {
                const sendTimeout = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error("Send timeout")), 5000)
                })

                await Promise.race([
                    new Promise((resolve, reject) => {
                        try {
                            agent.wsConnection.send(JSON.stringify(message), err => {
                                if (err) reject(err)
                                else resolve()
                            })
                        } catch (err) {
                            reject(err)
                        }
                    }),
                    sendTimeout
                ])

                this.runningTasks.set(run.id, { task, run, agent })
                logger.info(`✅ Task ${task.name} (ID: ${task.id}) sent to agent ${task.agentId}`)
            } catch (sendErr) {
                logger.error(`❌ Failed to send task to agent ${task.agentId}:`, sendErr)
                throw new Error(`Failed to send task to agent: ${sendErr.message}`)
            }

            // Send initial webhook notification
            try {
                await sendTaskResult({
                    taskId: task.id,
                    taskName: task.name,
                    agentId: task.agentId,
                    status: TASK_STATUSES.RUNNING,
                    stdout: "",
                    stderr: "",
                    exitCode: null,
                    durationMs: 0
                })
            } catch (webhookErr) {
                // Non-fatal error, just log it
                logger.warn(`⚠️ Failed to send webhook notification: ${webhookErr.message}`)
            }

            return true
        } catch (err) {
            logger.error(`❌ Error executing task ${task.name || task.id}:`, err)

            try {
                // Start transaction for error update with retry
                let retries = 3
                while (retries > 0) {
                    try {
                        await db.sequelize.transaction(async t => {
                            run.status = TASK_STATUSES.ERROR
                            run.stderr = err.toString()
                            await run.save({ transaction: t })
                        })
                        break
                    } catch (dbErr) {
                        retries--
                        if (retries === 0) {
                            logger.error(`❌ Critical: Failed to update task status in database:`, dbErr)
                        } else {
                            // Wait before retry with exponential backoff
                            const delay = Math.pow(2, 3 - retries) * 500
                            await new Promise(resolve => setTimeout(resolve, delay))
                        }
                    }
                }

                // Send error webhook notification - don't throw if this fails
                try {
                    await sendTaskResult({
                        taskId: task.id,
                        taskName: task.name,
                        agentId: task.agentId,
                        status: TASK_STATUSES.ERROR,
                        stdout: "",
                        stderr: err.toString(),
                        exitCode: 1,
                        durationMs: 0
                    })
                } catch (webhookErr) {
                    logger.warn(`⚠️ Failed to send error webhook notification: ${webhookErr.message}`)
                }
            } catch (finalErr) {
                logger.error(`❌ Critical: Unhandled error in error handling:`, finalErr)
            }

            return false
        }
    }

    /**
     * Cancel a running task
     * @param {number} taskId Task ID to cancel
     * @returns {Promise<boolean>} True if task was cancelled, false if not found or already completed
     */
    async cancelTask(taskId) {
        // Find running task by converting taskId to number for reliable comparison
        const numTaskId = Number(taskId)
        const runningTask = Array.from(this.runningTasks.values()).find(({ task }) => Number(task.id) === numTaskId)

        if (!runningTask) {
            logger.warn(`⚠️ No running task found with ID ${taskId}`)
            return false
        }

        const { task, run, agent } = runningTask

        try {
            // Send cancel message to agent
            const message = {
                type: "CANCEL_TASK",
                payload: {
                    taskId: task.id.toString(), // Ensure ID is sent as string for consistent handling
                    runId: run.id
                }
            }

            agent.wsConnection.send(JSON.stringify(message))

            // Update run status
            run.status = TASK_STATUSES.CANCELLED
            run.stderr = "Task cancelled by user"
            await run.save()

            // Remove from running tasks
            this.runningTasks.delete(run.id)

            logger.info(`Task ${task.name} cancelled`)
            return true
        } catch (err) {
            logger.error(`Failed to cancel task ${task.name}:`, err)
            return false
        }
    }

    /**
     * Handles the completion of a task, updating its status and triggering dependent tasks.
     */
    async handleTaskComplete(runId, result) {
        const running = this.runningTasks.get(runId)
        if (!running) {
            logger.warn(`⚠️ handleTaskComplete called for unknown run ID: ${runId}`)
            return
        }

        const { task, run } = running
        this.runningTasks.delete(runId)

        try {
            if (!result) {
                throw new Error("No result data provided")
            }

            // Input validation
            result.stdout = result.stdout || ""
            result.stderr = result.stderr || ""
            result.durationMs = result.durationMs || Math.max(0, new Date() - run.startedAt)

            // Update run record with shorter transaction and retry logic
            let retries = 3
            let succeeded = false

            while (retries > 0 && !succeeded) {
                try {
                    await db.sequelize.transaction(
                        {
                            isolationLevel: db.Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED
                        },
                        async t => {
                            // Update run record
                            run.status = result.error ? TASK_STATUSES.ERROR : TASK_STATUSES.SUCCESS
                            run.stdout = result.stdout
                            run.stderr = result.stderr
                            run.finishedAt = new Date()
                            run.durationMs = result.durationMs
                            await run.save({ transaction: t })
                        }
                    )
                    succeeded = true
                } catch (err) {
                    retries--
                    if (retries === 0) {
                        logger.error(`❌ Failed to update task ${task.name} completion after 3 retries:`, err)
                        throw err
                    }
                    // Wait before retry (exponential backoff)
                    const delay = Math.pow(2, 3 - retries) * 1000
                    logger.warn(`⚠️ Database error updating task status, retrying in ${delay}ms: ${err.message}`)
                    await new Promise(resolve => setTimeout(resolve, delay))
                }
            }

            // Get downstream tasks - separate from the transaction for better isolation
            try {
                const downstreamTasks = await this.getDownstreamTasks(task.id, run.status)

                // Queue downstream tasks
                for (const downTask of downstreamTasks) {
                    logger.info(`🔄 Queuing downstream task ${downTask.name} (ID: ${downTask.id})`)
                    await this.queueTask(downTask)
                }
            } catch (depErr) {
                logger.error(`❌ Error processing downstream tasks for ${task.name}:`, depErr)
                // Don't throw - this shouldn't prevent checking the queue
            }

            // Check queued tasks outside transaction
            try {
                for (const [taskId, queued] of this.taskQueue.entries()) {
                    const canRun = await this.checkDependencies(taskId)
                    if (canRun) {
                        logger.info(`⏩ Executing queued task ${queued.task.name} (ID: ${taskId})`)
                        this.taskQueue.delete(taskId)
                        await this.executeTask(queued.task, queued.run, queued.options)
                    }
                }
            } catch (queueErr) {
                logger.error(`❌ Error processing task queue after task completion:`, queueErr)
                // Non-fatal error, don't rethrow
            }

            logger.info(`✅ Task ${task.name} (ID: ${task.id}) completed with status: ${run.status}`)
        } catch (err) {
            logger.error(`❌ Error handling task completion for ${task.name} (ID: ${task.id}):`, err)

            // Last-resort error handling - make sure the task is marked as failed
            try {
                // Only update if not already updated in a transaction
                if (run.status === TASK_STATUSES.RUNNING) {
                    run.status = TASK_STATUSES.ERROR
                    run.stderr = (run.stderr || "") + "\n" + `Error during completion handling: ${err.message}`
                    run.finishedAt = new Date()
                    await run.save()
                }
            } catch (finalErr) {
                logger.error(`❌ Critical: Failed to update task status after error:`, finalErr)
            }
        }
    }

    /**
     * Handle agent connection
     * @param {string} agentId Agent ID
     * @param {Object} ws WebSocket connection
     */
    async handleAgentConnect(agentId, ws) {
        try {
            // Update agent status in database
            const agent = await db.Agent.findOne({ where: { agentId } })
            if (agent) {
                // We don't save wsConnection to the database, we only update the status
                await agent.update({
                    status: "online",
                    lastSeen: new Date()
                })
            }

            // Check queued tasks for this agent
            const queuedTasks = Array.from(this.taskQueue.entries()).filter(([_, { task }]) => task.agentId === agentId)

            for (const [taskId, queued] of queuedTasks) {
                const canRun = await this.checkDependencies(taskId)
                if (canRun) {
                    this.taskQueue.delete(taskId)
                    await this.executeTask(queued.task, queued.run, queued.options)
                }
            }
        } catch (err) {
            logger.error(`❌ Error handling agent connection for ${agentId}:`, err.message || "Unknown error")
            logger.debug(`Error details: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`)
        }
    }

    /**
     * Handle agent disconnect
     * @param {string} agentId Agent ID
     */
    async handleAgentDisconnect(agentId) {
        try {
            // If system is shutting down, skip database updates
            if (global.isShuttingDown) {
                logger.debug(`Skipping database update for agent ${agentId} during shutdown`)
                return
            }

            // Update agent status - using update instead of direct assignment of wsConnection
            const agent = await db.Agent.findOne({ where: { agentId } })
            if (agent) {
                await agent.update({
                    status: "offline"
                })
            }

            // Mark running tasks as error
            const affectedRuns = Array.from(this.runningTasks.values()).filter(({ agent }) => agent.agentId === agentId)

            for (const { task, run } of affectedRuns) {
                run.status = TASK_STATUSES.ERROR
                run.stderr = "Agent disconnected"
                await run.save()
                this.runningTasks.delete(run.id)
            }
        } catch (err) {
            logger.error(`❌ Error handling agent disconnect for ${agentId}:`, err.message || "Unknown error")
            logger.debug(`Error details: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`)
        }
    }

    /**
     * Run a task immediately
     * @param {number} taskId Task ID to run
     * @param {Object} options Run options
     * @returns {Promise<Object>} Task run record
     */
    async runTask(taskId, options = {}) {
        const task = await db.Task.findByPk(taskId)
        if (!task) {
            logger.error(`❌ Task ${taskId} not found in database`)
            throw new Error(`Task ${taskId} not found`)
        }

        // Check if task is already running
        const runningTask = await db.TaskRun.findOne({
            where: {
                taskId: task.id,
                status: TASK_STATUSES.RUNNING
            }
        })

        if (runningTask) {
            logger.error(`❌ Task ${task.name} is already running`)
            throw new Error(`Task ${task.name} is already running`)
        }

        const agentId = options.agentId || task.agentId

        if (!agentState.isAgentOnline(agentId)) {
            logger.error(`❌ Agent ${agentId} not connected`)
            throw new Error(`Agent ${agentId} not connected`)
        }

        const run = await db.TaskRun.create({
            taskId: task.id,
            agentId,
            status: TASK_STATUSES.PENDING
        })

        await this.queueTask(task, run, options)
        return run
    }
}

// Create and export a singleton instance
module.exports = new TaskManager()
