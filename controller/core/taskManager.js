const db = require("../db")
const logger = require("../utils/logger")
const { WebSocket } = require("ws")
const { DateTime } = require("luxon")
const agentState = require("./agentState")
const { sendTaskResult } = require("../services/webhook")

// Define constants for task statuses
const TASK_STATUSES = {
    PENDING: "pending",
    RUNNING: "running",
    SUCCESS: "success",
    ERROR: "error",
    CANCELLED: "cancelled"
};

class TaskManager {
    constructor() {
        this.runningTasks = new Map()
        this.taskQueue = new Map()
        
        // Synchronize state on startup
        this.syncRunningTasks().catch(err => {
            logger.error(`❌ Failed to sync running tasks:`, err)
        })
    }

    /**
     * Synchronize running tasks with database state
     * @private
     */
    async syncRunningTasks() {
        // Find all tasks marked as running in DB
        const runningInDb = await db.TaskRun.findAll({
            where: { status: TASK_STATUSES.RUNNING },
            include: [{
                model: db.Task,
                attributes: ["id", "name", "agentId"]
            }]
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
            include: [{
                model: db.Task,
                as: 'parentTask',
                attributes: ['id', 'name', 'agentId']
            }]
        })

        return dependencies.map(dep => ({
            taskId: dep.parentTask.id,
            condition: dep.condition || 'always'
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
                order: [['createdAt', 'DESC']]
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
            include: [{
                model: db.Task,
                as: 'childTask',
                attributes: ['id', 'name', 'agentId', 'type', 'script', 'params']
            }]
        })

        return dependencies
            .filter(dep => {
                const condition = dep.condition || 'always'
                switch (condition) {
                    case "on:success": return status === TASK_STATUSES.SUCCESS
                    case "on:error": return status === TASK_STATUSES.ERROR
                    case "always": return true
                    default: return false
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
                throw new Error("Agent offline")
            }

            if (agent.wsConnection.readyState !== WebSocket.OPEN) {
                logger.error(`❌ WebSocket connection not open for agent ${task.agentId} (state: ${agent.wsConnection.readyState})`)
                throw new Error("Agent offline")
            }

            // Start transaction for status update
            await db.sequelize.transaction(async (t) => {
                run.status = TASK_STATUSES.RUNNING
                run.startedAt = new Date()
                await run.save({ transaction: t })

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
                        options
                    }
                }

                agent.wsConnection.send(JSON.stringify(message))
                this.runningTasks.set(run.id, { task, run, agent })
            })
            
            // Send initial webhook notification
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
            
            return true

        } catch (err) {
            logger.error(`❌ Error executing task ${task.name}:`, err)
            // Start transaction for error update
            await db.sequelize.transaction(async (t) => {
                run.status = TASK_STATUSES.ERROR
                run.stderr = err.message
                await run.save({ transaction: t })
            })

            // Send error webhook notification
            await sendTaskResult({
                taskId: task.id,
                taskName: task.name,
                agentId: task.agentId,
                status: TASK_STATUSES.ERROR,
                stdout: "",
                stderr: err.message,
                exitCode: 1,
                durationMs: 0
            })

            return false
        }
    }

    /**
     * Cancel a running task
     * @param {number} taskId Task ID to cancel
     * @returns {Promise<boolean>} True if task was cancelled, false if not found or already completed
     */
    async cancelTask(taskId) {
        // Find running task
        const runningTask = Array.from(this.runningTasks.values())
            .find(({ task }) => task.id === taskId);

        if (!runningTask) {
            return false;
        }

        const { task, run, agent } = runningTask;

        try {
            // Send cancel message to agent
            const message = {
                type: "CANCEL_TASK",
                payload: {
                    taskId: task.id,
                    runId: run.id
                }
            };

            agent.wsConnection.send(JSON.stringify(message));

            // Update run status
            run.status = TASK_STATUSES.CANCELLED;
            run.stderr = "Task cancelled by user";
            await run.save();

            // Remove from running tasks
            this.runningTasks.delete(run.id);

            logger.info(`Task ${task.name} cancelled`);
            return true;

        } catch (err) {
            logger.error(`Failed to cancel task ${task.name}:`, err);
            return false;
        }
    }

    /**
     * Handles the completion of a task, updating its status and triggering dependent tasks.
     */
    async handleTaskComplete(runId, result) {
        const running = this.runningTasks.get(runId)
        if (!running) return

        const { task, run } = running
        this.runningTasks.delete(runId)

        try {
            // Update run record with shorter transaction and retry logic
            let retries = 3
            while (retries > 0) {
                try {
                    await db.sequelize.transaction({
                        isolationLevel: db.Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED
                    }, async (t) => {
                        // Update run record
                        run.status = result.error ? TASK_STATUSES.ERROR : TASK_STATUSES.SUCCESS
                        run.stdout = result.stdout
                        run.stderr = result.stderr
                        run.durationMs = result.durationMs || Math.max(0, new Date() - run.startedAt)
                        await run.save({ transaction: t })

                        // Get and queue downstream tasks
                        const downstreamTasks = await this.getDownstreamTasks(task.id, run.status)
                        for (const downTask of downstreamTasks) {
                            await this.queueTask(downTask)
                        }
                    })
                    break // If successful, exit retry loop
                } catch (err) {
                    retries--
                    if (retries === 0) throw err
                    // Wait before retry (exponential backoff)
                    await new Promise(resolve => setTimeout(resolve, (3 - retries) * 1000))
                }
            }

            // Check queued tasks outside transaction
            for (const [taskId, queued] of this.taskQueue.entries()) {
                const canRun = await this.checkDependencies(taskId)
                if (canRun) {
                    this.taskQueue.delete(taskId)
                    await this.executeTask(queued.task, queued.run, queued.options)
                }
            }

            logger.info(`✅ Task ${task.name} completed with status: ${run.status}`)
        } catch (err) {
            logger.error(`❌ Error handling task completion for ${task.name}:`, err)
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
                });
            }

            // Check queued tasks for this agent
            const queuedTasks = Array.from(this.taskQueue.entries())
                .filter(([_, { task }]) => task.agentId === agentId)

            for (const [taskId, queued] of queuedTasks) {
                const canRun = await this.checkDependencies(taskId)
                if (canRun) {
                    this.taskQueue.delete(taskId)
                    await this.executeTask(queued.task, queued.run, queued.options)
                }
            }
        } catch (err) {
            logger.error(`❌ Error handling agent connection for ${agentId}:`, err.message || 'Unknown error')
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
                logger.debug(`Skipping database update for agent ${agentId} during shutdown`);
                return;
            }
            
            // Update agent status - using update instead of direct assignment of wsConnection
            const agent = await db.Agent.findOne({ where: { agentId } })
            if (agent) {
                await agent.update({
                    status: "offline"
                })
            }

            // Mark running tasks as error
            const affectedRuns = Array.from(this.runningTasks.values())
                .filter(({ agent }) => agent.agentId === agentId)

            for (const { task, run } of affectedRuns) {
                run.status = TASK_STATUSES.ERROR
                run.stderr = "Agent disconnected"
                await run.save()
                this.runningTasks.delete(run.id)
            }
        } catch (err) {
            logger.error(`❌ Error handling agent disconnect for ${agentId}:`, err.message || 'Unknown error')
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
