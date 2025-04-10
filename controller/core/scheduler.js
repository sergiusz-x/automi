/**
 * Task Scheduler Module
 * Manages scheduled task execution using cron expressions
 */
const cron = require("node-cron")
const logger = require("../utils/logger")
const db = require("../db")
const taskManager = require("./taskManager")

// Store active cron jobs for management
const activeJobs = new Map()

/**
 * Initialize and start the task scheduler
 * Loads enabled tasks with schedules and creates cron jobs
 */
async function startScheduler() {
    logger.info("⏱️ Starting Automi scheduler...")

    try {
        // Load all enabled tasks that have a schedule
        const tasks = await db.Task.findAll({
            where: {
                enabled: true,
                schedule: {
                    [db.Sequelize.Op.ne]: null
                }
            }
        })

        if (!tasks.length) {
            logger.info("ℹ️ No scheduled tasks found in database.")
            return
        }

        // Create cron job for each task
        for (const task of tasks) {
            try {
                if (!cron.validate(task.schedule)) {
                    logger.error(`❌ Invalid cron schedule for task ${task.name}: ${task.schedule}`)
                    continue
                }

                const job = cron.schedule(task.schedule, async () => {
                    logger.info(`⏰ Scheduled trigger for task: ${task.name}`)
                    try {
                        await taskManager.runTask(task.id)
                    } catch (err) {
                        logger.error(`❌ Failed to execute scheduled task ${task.name}:`, err)
                    }
                })

                activeJobs.set(task.id, job)
                logger.info(`📅 Task "${task.name}" scheduled: ${task.schedule}`)
            } catch (err) {
                logger.error(`❌ Failed to schedule task ${task.name}:`, err)
            }
        }

        logger.info(`✅ Scheduler initialized with ${tasks.length} tasks`)
        
        // Set up task modification hooks
        setupTaskHooks()
    } catch (err) {
        logger.error("❌ Failed to start scheduler:", err)
        throw err
    }
}

/**
 * Set up database hooks to manage cron jobs when tasks are modified
 */
function setupTaskHooks() {
    db.Task.afterUpdate(async (task) => {
        const existingJob = activeJobs.get(task.id)

        // Stop existing job if task is disabled or schedule removed
        if (existingJob && (!task.enabled || !task.schedule)) {
            existingJob.stop()
            activeJobs.delete(task.id)
            logger.info(`🛑 Stopped schedule for task: ${task.name}`)
            return
        }

        // Update or create job if task is enabled and has schedule
        if (task.enabled && task.schedule) {
            if (existingJob) {
                existingJob.stop()
            }

            if (!cron.validate(task.schedule)) {
                logger.error(`❌ Invalid cron schedule for task ${task.name}: ${task.schedule}`)
                return
            }

            const job = cron.schedule(task.schedule, async () => {
                logger.info(`⏰ Scheduled trigger for task: ${task.name}`)
                try {
                    await taskManager.runTask(task.id)
                } catch (err) {
                    logger.error(`❌ Failed to execute scheduled task ${task.name}:`, err)
                }
            })

            activeJobs.set(task.id, job)
            logger.info(`🔄 Updated schedule for task ${task.name}: ${task.schedule}`)
        }
    })

    db.Task.afterDestroy((task) => {
        const job = activeJobs.get(task.id)
        if (job) {
            job.stop()
            activeJobs.delete(task.id)
            logger.info(`🗑️ Removed schedule for deleted task: ${task.name}`)
        }
    })
}

/**
 * Stop all active cron jobs
 * Used during shutdown or reset
 */
function stopAllJobs() {
    for (const [taskId, job] of activeJobs) {
        job.stop()
        logger.debug(`🛑 Stopped job ${taskId}`)
    }
    activeJobs.clear()
    logger.info("✅ All scheduled jobs stopped")
}

module.exports = startScheduler
// Export stopAllJobs for use during shutdown
module.exports.stopAllJobs = stopAllJobs
