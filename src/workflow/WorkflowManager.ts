/**
 * WorkflowManager - Manages workflow state persistence and operations.
 *
 * Handles:
 * - State persistence to .cursor/agents/state/
 * - Workflow creation, update, and retrieval
 * - Checkpoint management
 * - Artifact and feedback tracking
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  ArtifactRecord,
  ArtifactType,
  CheckpointDecision,
  CheckpointRecord,
  FeedbackRecord,
  WorkflowPhase,
  WorkflowState,
  WorkflowStatus,
} from 'src/types/WorkflowState'
import { createWorkflowState } from 'src/types/WorkflowState'
import { Logger } from 'src/utils/Logger'

/**
 * Options for updating workflow state.
 */
export interface WorkflowUpdateOptions {
  phase?: WorkflowPhase
  iteration?: number
  status?: WorkflowStatus
  current_artifact?: string
  checkpoint_message?: string
}

/**
 * Options for adding an artifact.
 */
export interface AddArtifactOptions {
  type: ArtifactType
  file: string
  created_by: string
}

/**
 * Options for adding feedback.
 */
export interface AddFeedbackOptions {
  reviewer: string
  feedback_file: string
}

/**
 * Manages workflow state for multi-agent orchestration.
 */
export class WorkflowManager {
  private readonly logger: Logger
  private readonly stateDir: string
  private readonly workflows: Map<string, WorkflowState> = new Map()

  constructor(baseDir?: string) {
    this.logger = new Logger('debug')
    this.stateDir = baseDir
      ? path.join(baseDir, '.cursor', 'agents', 'state')
      : path.join(process.cwd(), '.cursor', 'agents', 'state')
    this.logger.debug('WorkflowManager initialized', { stateDir: this.stateDir })
  }

  /**
   * Ensure the state directory exists.
   */
  private async ensureStateDir(): Promise<void> {
    await fs.promises.mkdir(this.stateDir, { recursive: true })
  }

  /**
   * Get the file path for a workflow state file.
   */
  private getStatePath(workflowId: string): string {
    return path.join(this.stateDir, `${workflowId}.json`)
  }

  /**
   * Create a new workflow.
   */
  async createWorkflow(
    workflowId: string,
    phase: WorkflowPhase = 'planning'
  ): Promise<WorkflowState> {
    this.logger.info('Creating workflow', { workflowId, phase })

    // Check if workflow already exists
    const existing = await this.getWorkflow(workflowId)
    if (existing) {
      throw new Error(`Workflow ${workflowId} already exists`)
    }

    const state = createWorkflowState(workflowId, phase)
    await this.saveWorkflow(state)

    this.logger.info('Workflow created', { workflowId })
    return state
  }

  /**
   * Get a workflow by ID.
   */
  async getWorkflow(workflowId: string): Promise<WorkflowState | undefined> {
    // Check cache first
    if (this.workflows.has(workflowId)) {
      return this.workflows.get(workflowId)
    }

    // Try to load from disk
    const statePath = this.getStatePath(workflowId)
    try {
      const data = await fs.promises.readFile(statePath, 'utf-8')
      const state = JSON.parse(data) as WorkflowState
      this.workflows.set(workflowId, state)
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  }

  /**
   * Get or create a workflow.
   */
  async getOrCreateWorkflow(
    workflowId: string,
    phase: WorkflowPhase = 'planning'
  ): Promise<WorkflowState> {
    const existing = await this.getWorkflow(workflowId)
    if (existing) {
      return existing
    }
    return this.createWorkflow(workflowId, phase)
  }

  /**
   * Save workflow state to disk.
   */
  async saveWorkflow(state: WorkflowState): Promise<void> {
    await this.ensureStateDir()

    state.updated_at = new Date().toISOString()
    const statePath = this.getStatePath(state.workflow_id)

    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8')
    this.workflows.set(state.workflow_id, state)

    this.logger.debug('Workflow saved', { workflowId: state.workflow_id })
  }

  /**
   * Update workflow state.
   */
  async updateWorkflow(workflowId: string, options: WorkflowUpdateOptions): Promise<WorkflowState> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    if (options.phase !== undefined) {
      state.phase = options.phase
    }
    if (options.iteration !== undefined) {
      state.iteration = options.iteration
    }
    if (options.status !== undefined) {
      state.status = options.status
    }
    if (options.current_artifact !== undefined) {
      state.current_artifact = options.current_artifact
    }
    if (options.checkpoint_message !== undefined) {
      state.checkpoint_message = options.checkpoint_message
    }

    await this.saveWorkflow(state)
    this.logger.info('Workflow updated', { workflowId, options })

    return state
  }

  /**
   * Add an artifact to the workflow.
   */
  async addArtifact(workflowId: string, options: AddArtifactOptions): Promise<WorkflowState> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const artifact: ArtifactRecord = {
      iteration: state.iteration,
      type: options.type,
      file: options.file,
      created_by: options.created_by,
      created_at: new Date().toISOString(),
    }

    state.artifacts.push(artifact)
    await this.saveWorkflow(state)

    this.logger.info('Artifact added', { workflowId, artifact })
    return state
  }

  /**
   * Add feedback from a reviewer.
   */
  async addFeedback(workflowId: string, options: AddFeedbackOptions): Promise<WorkflowState> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const feedback: FeedbackRecord = {
      iteration: state.iteration,
      reviewer: options.reviewer,
      feedback_file: options.feedback_file,
      addressed: false,
      created_at: new Date().toISOString(),
    }

    state.feedback_history.push(feedback)
    await this.saveWorkflow(state)

    this.logger.info('Feedback added', { workflowId, feedback })
    return state
  }

  /**
   * Mark feedback as addressed.
   */
  async markFeedbackAddressed(
    workflowId: string,
    reviewer: string,
    iteration?: number
  ): Promise<WorkflowState> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const targetIteration = iteration ?? state.iteration
    for (const feedback of state.feedback_history) {
      if (feedback.reviewer === reviewer && feedback.iteration === targetIteration) {
        feedback.addressed = true
      }
    }

    await this.saveWorkflow(state)
    this.logger.info('Feedback marked addressed', {
      workflowId,
      reviewer,
      iteration: targetIteration,
    })
    return state
  }

  /**
   * Record an agent run.
   */
  async recordAgentRun(
    workflowId: string,
    agent: string,
    contextFiles: string[],
    outputFile: string
  ): Promise<{ state: WorkflowState; runIndex: number }> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const run = {
      agent,
      iteration: state.iteration,
      context_files: contextFiles,
      output_file: outputFile,
      started_at: new Date().toISOString(),
    }

    const runIndex = state.agent_runs.push(run) - 1
    await this.saveWorkflow(state)

    this.logger.debug('Agent run recorded', { workflowId, agent, runIndex })
    return { state, runIndex }
  }

  /**
   * Complete an agent run.
   */
  async completeAgentRun(
    workflowId: string,
    runIndex: number,
    success: boolean,
    error?: string
  ): Promise<WorkflowState> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const run = state.agent_runs[runIndex]
    if (!run) {
      throw new Error(`Agent run ${runIndex} not found in workflow ${workflowId}`)
    }

    run.completed_at = new Date().toISOString()
    run.success = success
    if (error) {
      run.error = error
    }

    await this.saveWorkflow(state)
    this.logger.debug('Agent run completed', { workflowId, runIndex, success })
    return state
  }

  /**
   * Record a checkpoint decision.
   */
  async recordCheckpoint(
    workflowId: string,
    decision: CheckpointDecision,
    feedback?: string
  ): Promise<WorkflowState> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const checkpoint: CheckpointRecord = {
      iteration: state.iteration,
      decision,
      feedback,
      decided_at: new Date().toISOString(),
    }

    state.checkpoints_passed.push(checkpoint)

    // Update workflow status based on decision
    switch (decision) {
      case 'continue':
        state.status = 'working'
        break
      case 'iterate':
        state.iteration += 1
        state.status = 'working'
        state.checkpoint_message = undefined
        break
      case 'approve':
        state.status = 'complete'
        state.checkpoint_message = undefined
        break
      case 'reject':
        state.status = 'rejected'
        break
    }

    await this.saveWorkflow(state)
    this.logger.info('Checkpoint recorded', { workflowId, decision, feedback })
    return state
  }

  /**
   * Pause workflow at a checkpoint.
   */
  async pauseAtCheckpoint(workflowId: string, message: string): Promise<WorkflowState> {
    return this.updateWorkflow(workflowId, {
      status: 'checkpoint',
      checkpoint_message: message,
    })
  }

  /**
   * Get the verifier for a reviewer.
   */
  async getVerifierForReviewer(workflowId: string, reviewer: string): Promise<string | undefined> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }
    return state.reviewer_verifier_map[reviewer]
  }

  /**
   * Get unaddressed feedback for the current iteration.
   */
  async getUnaddressedFeedback(workflowId: string): Promise<FeedbackRecord[]> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    return state.feedback_history.filter((f) => f.iteration === state.iteration && !f.addressed)
  }

  /**
   * Get latest artifact of a specific type.
   */
  async getLatestArtifact(
    workflowId: string,
    type: ArtifactType
  ): Promise<ArtifactRecord | undefined> {
    const state = await this.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const artifacts = state.artifacts
      .filter((a) => a.type === type)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return artifacts[0]
  }

  /**
   * List all workflows.
   */
  async listWorkflows(): Promise<WorkflowState[]> {
    await this.ensureStateDir()

    const files = await fs.promises.readdir(this.stateDir)
    const workflows: WorkflowState[] = []

    for (const file of files) {
      if (file.endsWith('.json')) {
        const workflowId = file.replace('.json', '')
        const state = await this.getWorkflow(workflowId)
        if (state) {
          workflows.push(state)
        }
      }
    }

    return workflows.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )
  }

  /**
   * Delete a workflow.
   */
  async deleteWorkflow(workflowId: string): Promise<boolean> {
    const statePath = this.getStatePath(workflowId)
    try {
      await fs.promises.unlink(statePath)
      this.workflows.delete(workflowId)
      this.logger.info('Workflow deleted', { workflowId })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false
      }
      throw error
    }
  }
}
