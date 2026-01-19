/**
 * WorkflowExecutor - Executes workflow phases with agent coordination.
 *
 * Handles:
 * - Running creator agents
 * - Running reviewers in parallel
 * - Running verifiers with reviewer context
 * - Managing checkpoints
 * - Iterative refinement loops
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutor } from 'src/execution/AgentExecutor'
import type { AgentModelId } from 'src/types/AgentDefinition'
import { MODEL_MAP } from 'src/types/AgentDefinition'
import type {
  InterpolationContext,
  IterativePhaseDefinition,
  PhaseDefinition,
  TestExecutionPhaseDefinition,
  WorkflowDefinition,
} from 'src/types/WorkflowDefinition'
import { isIterativePhase, isTestExecutionPhase } from 'src/types/WorkflowDefinition'
import type { WorkflowPhase, WorkflowState } from 'src/types/WorkflowState'
import { Logger } from 'src/utils/Logger'
import { WorkflowLoader } from './WorkflowLoader'
import type { WorkflowManager } from './WorkflowManager'

/**
 * Result of a phase step execution.
 */
export interface StepResult {
  success: boolean
  outputs: string[]
  error?: string | undefined
  duration_ms: number
}

/**
 * Result of running a complete iteration.
 */
export interface IterationResult {
  success: boolean
  iteration: number
  creator_output?: string | undefined
  review_outputs: string[]
  verification_outputs: string[]
  needs_iteration: boolean
  checkpoint_reached: boolean
  error?: string | undefined
}

/**
 * Status message for workflow progress.
 */
export interface WorkflowProgressMessage {
  phase: WorkflowPhase
  iteration: number
  step: 'creator' | 'review' | 'checkpoint' | 'verification' | 'complete'
  message: string
  artifacts?: string[]
}

/**
 * Executes workflow phases with agent coordination.
 */
export class WorkflowExecutor {
  private readonly logger: Logger
  private readonly workflowLoader: WorkflowLoader

  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly agentManager: AgentManager,
    private readonly workflowManager: WorkflowManager
  ) {
    this.logger = new Logger('debug')
    this.workflowLoader = new WorkflowLoader()
  }

  /**
   * Start a new workflow from a definition.
   */
  async startWorkflow(
    definition: WorkflowDefinition,
    workflowId: string,
    inputFile?: string
  ): Promise<WorkflowState> {
    this.logger.info('Starting workflow', {
      workflowId,
      name: definition.name,
      phases: definition.phases.length,
    })

    // Create the workflow state
    const firstPhase = definition.phases[0]
    if (!firstPhase) {
      throw new Error('Workflow definition must have at least one phase')
    }
    const state = await this.workflowManager.createWorkflow(workflowId, firstPhase.id)

    // Store the definition reference
    if (inputFile) {
      await this.workflowManager.updateWorkflow(workflowId, {
        status: 'working',
        current_artifact: inputFile,
      })
    } else {
      await this.workflowManager.updateWorkflow(workflowId, {
        status: 'working',
      })
    }

    return state
  }

  /**
   * Execute a single step in the workflow (non-blocking).
   * Returns the next action needed.
   */
  async executeStep(
    definition: WorkflowDefinition,
    workflowId: string
  ): Promise<WorkflowProgressMessage> {
    const state = await this.workflowManager.getWorkflow(workflowId)
    if (!state) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const phase = definition.phases.find((p) => p.id === state.phase)
    if (!phase) {
      throw new Error(`Phase ${state.phase} not found in workflow definition`)
    }

    const context = this.buildInterpolationContext(definition, state)

    if (isIterativePhase(phase)) {
      return this.executeIterativeStep(definition, phase, state, context)
    }

    if (isTestExecutionPhase(phase)) {
      return this.executeTestExecutionStep(definition, phase, state, context)
    }

    throw new Error(`Unknown phase type: ${(phase as PhaseDefinition).type}`)
  }

  /**
   * Execute a step in an iterative phase.
   */
  private async executeIterativeStep(
    definition: WorkflowDefinition,
    phase: IterativePhaseDefinition,
    state: WorkflowState,
    context: InterpolationContext
  ): Promise<WorkflowProgressMessage> {
    // Determine what step we're at based on state
    if (state.status === 'idle' || state.status === 'working') {
      // Run the creator agent
      return this.runCreatorStep(definition, phase, state, context)
    }

    if (state.status === 'checkpoint') {
      // Waiting for human approval
      return {
        phase: phase.id,
        iteration: state.iteration,
        step: 'checkpoint',
        message: state.checkpoint_message || 'Waiting for review',
        artifacts: state.artifacts
          .filter((a) => a.iteration === state.iteration)
          .map((a) => a.file),
      }
    }

    if (state.status === 'reviewing') {
      // Run reviewers
      return this.runReviewStep(definition, phase, state, context)
    }

    if (state.status === 'verifying') {
      // Run verifiers
      return this.runVerificationStep(definition, phase, state, context)
    }

    return {
      phase: phase.id,
      iteration: state.iteration,
      step: 'complete',
      message: `Phase ${phase.id} complete`,
    }
  }

  /**
   * Run the creator agent step.
   */
  private async runCreatorStep(
    definition: WorkflowDefinition,
    phase: IterativePhaseDefinition,
    state: WorkflowState,
    context: InterpolationContext
  ): Promise<WorkflowProgressMessage> {
    const workflowId = state.workflow_id

    // Build output path
    const outputs = this.workflowLoader.interpolateOutputs(phase.outputs, context)
    const outputPath = outputs?.artifact || this.getDefaultArtifactPath(definition, phase, state)

    // Ensure output directory exists
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

    // Build context files
    const contextFiles = await this.resolveContextFiles(phase.context, context)

    // Get previous iteration's feedback if this is iteration > 1
    if (state.iteration > 1) {
      const prevFeedback = state.feedback_history.filter(
        (f) => f.iteration === state.iteration - 1 && !f.addressed
      )
      for (const fb of prevFeedback) {
        contextFiles.push(fb.feedback_file)
      }
    }

    // Run the creator agent
    const result = await this.runAgent(phase.creator, contextFiles, outputPath, state)

    if (!result.success) {
      return {
        phase: phase.id,
        iteration: state.iteration,
        step: 'creator',
        message: `Creator agent failed: ${result.error}`,
      }
    }

    // Record the artifact
    await this.workflowManager.addArtifact(workflowId, {
      type: 'plan',
      file: outputPath,
      created_by: phase.creator,
    })

    // Move to checkpoint
    await this.workflowManager.pauseAtCheckpoint(
      workflowId,
      phase.checkpoint_message ||
        `Review ${phase.id} iteration ${state.iteration} artifact at: ${outputPath}`
    )

    return {
      phase: phase.id,
      iteration: state.iteration,
      step: 'checkpoint',
      message: 'Creator completed. Review required.',
      artifacts: [outputPath],
    }
  }

  /**
   * Run reviewers in parallel.
   */
  private async runReviewStep(
    definition: WorkflowDefinition,
    phase: IterativePhaseDefinition,
    state: WorkflowState,
    context: InterpolationContext
  ): Promise<WorkflowProgressMessage> {
    const workflowId = state.workflow_id

    // Get the current artifact
    const currentArtifact = state.artifacts
      .filter((a) => a.iteration === state.iteration)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

    if (!currentArtifact) {
      throw new Error('No artifact found for current iteration')
    }

    // Build review output paths
    const outputs = this.workflowLoader.interpolateOutputs(phase.outputs, context)
    const reviewDir =
      outputs?.reviews || path.join(definition.output_dir || '.cursor/agents/workflow', 'reviews')

    await fs.promises.mkdir(reviewDir, { recursive: true })

    // Run reviewers in parallel
    const reviewPromises = phase.reviewers.map(async (reviewer) => {
      const outputPath = path.join(reviewDir, `${reviewer}-v${state.iteration}.md`)

      const result = await this.runAgent(reviewer, [currentArtifact.file], outputPath, state)

      if (result.success) {
        await this.workflowManager.addFeedback(workflowId, {
          reviewer,
          feedback_file: outputPath,
        })
      }

      return { reviewer, success: result.success, outputPath, error: result.error }
    })

    const results = await Promise.all(reviewPromises)
    const successful = results.filter((r) => r.success)
    const failed = results.filter((r) => !r.success)

    // Move to verification
    await this.workflowManager.updateWorkflow(workflowId, { status: 'verifying' })

    return {
      phase: phase.id,
      iteration: state.iteration,
      step: 'review',
      message: `Reviews complete: ${successful.length} succeeded, ${failed.length} failed`,
      artifacts: results.map((r) => r.outputPath),
    }
  }

  /**
   * Run verifiers in parallel with reviewer context mapping.
   */
  private async runVerificationStep(
    definition: WorkflowDefinition,
    phase: IterativePhaseDefinition,
    state: WorkflowState,
    context: InterpolationContext
  ): Promise<WorkflowProgressMessage> {
    const workflowId = state.workflow_id

    // Get current artifact
    const currentArtifact = state.artifacts
      .filter((a) => a.iteration === state.iteration && a.type !== 'review')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

    if (!currentArtifact) {
      throw new Error('No artifact found for verification')
    }

    // Get feedback for this iteration
    const currentFeedback = state.feedback_history.filter(
      (f) => f.iteration === state.iteration && !f.addressed
    )

    // Build verification output paths
    const outputs = this.workflowLoader.interpolateOutputs(phase.outputs, context)
    const verifyDir =
      outputs?.verifications ||
      path.join(definition.output_dir || '.cursor/agents/workflow', 'verifications')

    await fs.promises.mkdir(verifyDir, { recursive: true })

    // Run verifiers in parallel - each gets their corresponding reviewer's feedback
    const verifyPromises = phase.verifiers.map(async (verifier, index) => {
      const outputPath = path.join(verifyDir, `${verifier}-v${state.iteration}.md`)

      // Find the corresponding reviewer's feedback
      const correspondingReviewer = phase.reviewers[index]
      const feedback = currentFeedback.find((f) => f.reviewer === correspondingReviewer)

      const contextFiles = [currentArtifact.file]
      if (feedback) {
        contextFiles.push(feedback.feedback_file)
      }

      const result = await this.runAgent(verifier, contextFiles, outputPath, state)

      if (result.success) {
        await this.workflowManager.addArtifact(workflowId, {
          type: 'verification',
          file: outputPath,
          created_by: verifier,
        })
      }

      return { verifier, success: result.success, outputPath, error: result.error }
    })

    const results = await Promise.all(verifyPromises)
    const successful = results.filter((r) => r.success)

    // Check if all verifiers passed (simplified - would need actual parsing)
    const allPassed = successful.length === phase.verifiers.length
    const minIterationsReached = state.iteration >= (phase.min_iterations || 1)
    const maxIterationsReached = phase.max_iterations
      ? state.iteration >= phase.max_iterations
      : false

    // Force completion if max iterations reached
    if (maxIterationsReached) {
      this.logger.warn('Max iterations reached, forcing phase completion', {
        phase: phase.id,
        iteration: state.iteration,
        max_iterations: phase.max_iterations,
      })

      const nextPhase = this.getNextPhase(definition, phase.id)
      if (nextPhase) {
        await this.workflowManager.updateWorkflow(workflowId, {
          phase: nextPhase.id,
          iteration: 1,
          status: 'working',
        })
        return {
          phase: phase.id,
          iteration: state.iteration,
          step: 'complete',
          message: `Phase ${phase.id} complete (max iterations reached). Moving to ${nextPhase.id}`,
          artifacts: results.map((r) => r.outputPath),
        }
      }
      // Workflow complete
      await this.workflowManager.updateWorkflow(workflowId, { status: 'complete' })
      return {
        phase: phase.id,
        iteration: state.iteration,
        step: 'complete',
        message: 'Workflow complete (max iterations reached)!',
        artifacts: results.map((r) => r.outputPath),
      }
    }

    if (allPassed && minIterationsReached) {
      // Phase complete - move to next phase
      const nextPhase = this.getNextPhase(definition, phase.id)
      if (nextPhase) {
        await this.workflowManager.updateWorkflow(workflowId, {
          phase: nextPhase.id,
          iteration: 1,
          status: 'working',
        })
        return {
          phase: phase.id,
          iteration: state.iteration,
          step: 'complete',
          message: `Phase ${phase.id} complete. Moving to ${nextPhase.id}`,
          artifacts: results.map((r) => r.outputPath),
        }
      }
      // Workflow complete
      await this.workflowManager.updateWorkflow(workflowId, { status: 'complete' })
      return {
        phase: phase.id,
        iteration: state.iteration,
        step: 'complete',
        message: 'Workflow complete!',
        artifacts: results.map((r) => r.outputPath),
      }
    }

    // Need another iteration - pause for checkpoint
    await this.workflowManager.pauseAtCheckpoint(
      workflowId,
      'Verification complete. Review findings and decide: continue, iterate, or approve.'
    )

    return {
      phase: phase.id,
      iteration: state.iteration,
      step: 'verification',
      message: `Verification complete. ${successful.length}/${phase.verifiers.length} passed.`,
      artifacts: results.map((r) => r.outputPath),
    }
  }

  /**
   * Execute a step in a test execution phase.
   *
   * Test execution follows this flow:
   * 1. Run tester agent to execute tests and analyze failures
   * 2. If failures: pause for checkpoint, then run fixer agent
   * 3. Loop back to step 1 until all tests pass or max iterations reached
   */
  private async executeTestExecutionStep(
    definition: WorkflowDefinition,
    phase: TestExecutionPhaseDefinition,
    state: WorkflowState,
    context: InterpolationContext
  ): Promise<WorkflowProgressMessage> {
    const workflowId = state.workflow_id

    // Check if max iterations reached
    const maxIterationsReached = phase.max_iterations
      ? state.iteration >= phase.max_iterations
      : false

    if (maxIterationsReached && state.status === 'working') {
      this.logger.warn('Max test iterations reached, completing workflow', {
        phase: phase.id,
        iteration: state.iteration,
        max_iterations: phase.max_iterations,
      })

      await this.workflowManager.updateWorkflow(workflowId, { status: 'complete' })
      return {
        phase: phase.id,
        iteration: state.iteration,
        step: 'complete',
        message: 'Workflow complete (max test iterations reached). Review final test results.',
      }
    }

    if (state.status === 'working' || state.status === 'idle') {
      // Run tests
      const outputs = this.workflowLoader.interpolateOutputs(phase.outputs, context)
      const outputPath =
        outputs?.artifact ||
        path.join(
          definition.output_dir || '.cursor/agents/workflow',
          'test-results',
          `run-${state.iteration}.md`
        )

      await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })

      // Build context files for tester - include previous test results and any fix outputs
      const contextFiles: string[] = []

      // Add previous iteration's test results if available
      const prevTestResults = state.artifacts
        .filter((a) => a.type === 'test-result' && a.iteration === state.iteration - 1)
        .map((a) => a.file)
      contextFiles.push(...prevTestResults)

      // Add context from phase definition
      if (phase.context) {
        const resolvedContext = await this.resolveContextFiles(phase.context, context)
        contextFiles.push(...resolvedContext)
      }

      const result = await this.runAgent(phase.tester, contextFiles, outputPath, state)

      if (!result.success) {
        return {
          phase: phase.id,
          iteration: state.iteration,
          step: 'creator',
          message: `Test execution failed: ${result.error}`,
        }
      }

      await this.workflowManager.addArtifact(workflowId, {
        type: 'test-result',
        file: outputPath,
        created_by: phase.tester,
      })

      await this.workflowManager.pauseAtCheckpoint(
        workflowId,
        `Test results available at ${outputPath}. Review and decide:\n- "approve": All tests pass, workflow complete\n- "iterate": Tests failed, run fixer agent to address failures\n- "reject": Abort the testing phase`
      )

      return {
        phase: phase.id,
        iteration: state.iteration,
        step: 'checkpoint',
        message: 'Tests executed. Review results.',
        artifacts: [outputPath],
      }
    }

    if (state.status === 'verifying') {
      // In test-execution, 'verifying' status means we should run the fixer agent
      return this.runFixerStep(definition, phase, state, context)
    }

    return {
      phase: phase.id,
      iteration: state.iteration,
      step: 'checkpoint',
      message: state.checkpoint_message || 'Awaiting decision',
    }
  }

  /**
   * Run the fixer agent to address test failures.
   */
  private async runFixerStep(
    definition: WorkflowDefinition,
    phase: TestExecutionPhaseDefinition,
    state: WorkflowState,
    _context: InterpolationContext
  ): Promise<WorkflowProgressMessage> {
    const workflowId = state.workflow_id

    // Get the latest test results
    const testResults = state.artifacts
      .filter((a) => a.type === 'test-result' && a.iteration === state.iteration)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]

    if (!testResults) {
      throw new Error('No test results found for fixer to work with')
    }

    // Build output path for fixer
    const fixOutputPath = path.join(
      definition.output_dir || '.cursor/agents/workflow',
      'fixes',
      `fix-${state.iteration}.md`
    )

    await fs.promises.mkdir(path.dirname(fixOutputPath), { recursive: true })

    // Context for fixer: test results + previous implementation artifacts
    const contextFiles = [testResults.file]

    // Add implementation artifacts from the implementation phase
    const implArtifacts = state.artifacts
      .filter((a) => a.type === 'implementation' || a.type === 'plan')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    const firstImplArtifact = implArtifacts[0]
    if (firstImplArtifact) {
      contextFiles.push(firstImplArtifact.file)
    }

    const result = await this.runAgent(phase.fixer, contextFiles, fixOutputPath, state)

    if (!result.success) {
      this.logger.error('Fixer agent failed', result.error ? new Error(result.error) : undefined)
      // Still move forward - maybe human can intervene
      await this.workflowManager.pauseAtCheckpoint(
        workflowId,
        `Fixer agent failed: ${result.error}. Review and decide how to proceed.`
      )
      return {
        phase: phase.id,
        iteration: state.iteration,
        step: 'checkpoint',
        message: `Fixer failed: ${result.error}`,
      }
    }

    await this.workflowManager.addArtifact(workflowId, {
      type: 'implementation',
      file: fixOutputPath,
      created_by: phase.fixer,
    })

    // Move to next iteration and run tests again
    await this.workflowManager.updateWorkflow(workflowId, {
      iteration: state.iteration + 1,
      status: 'working',
    })

    this.logger.info('Fix applied, starting next test iteration', {
      phase: phase.id,
      iteration: state.iteration + 1,
      fixOutput: fixOutputPath,
    })

    return {
      phase: phase.id,
      iteration: state.iteration,
      step: 'verification',
      message: 'Fix applied. Re-running tests.',
      artifacts: [fixOutputPath],
    }
  }

  /**
   * Run a single agent.
   */
  private async runAgent(
    agentName: string,
    contextFiles: string[],
    outputPath: string,
    _state: WorkflowState
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const startTime = Date.now()

    try {
      const agentDef = await this.agentManager.getAgent(agentName)
      if (!agentDef) {
        return { success: false, error: `Agent ${agentName} not found` }
      }

      // Build context
      let contextSection = ''
      for (const file of contextFiles) {
        try {
          const content = await fs.promises.readFile(file, 'utf-8')
          contextSection += `\n## File: ${file}\n\`\`\`\n${content}\n\`\`\`\n`
        } catch {
          this.logger.warn('Failed to read context file', { file })
        }
      }

      const fullPrompt = contextSection
        ? `# Context\n${contextSection}\n---\n\n# Instructions\n\nPerform your task based on the context provided.`
        : 'Perform your task.'

      const modelId = agentDef.model
      const model = MODEL_MAP[modelId as AgentModelId]

      const result = await this.agentExecutor.executeAgent({
        agent: agentDef.content,
        prompt: fullPrompt,
        cwd: process.cwd(),
        model,
      })

      // Write output
      await fs.promises.writeFile(outputPath, result.stdout, 'utf-8')

      this.logger.debug('Agent executed', {
        agent: agentName,
        duration: Date.now() - startTime,
        outputPath,
      })

      return { success: true, output: result.stdout }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Resolve context file patterns.
   */
  private async resolveContextFiles(
    patterns: string[] | undefined,
    context: InterpolationContext
  ): Promise<string[]> {
    if (!patterns) return []

    const files: string[] = []
    for (const pattern of patterns) {
      const interpolated = this.workflowLoader.interpolate(pattern, context)
      try {
        const stat = await fs.promises.stat(interpolated)
        if (stat.isFile()) {
          files.push(interpolated)
        }
      } catch {
        // File doesn't exist yet
      }
    }
    return files
  }

  /**
   * Build interpolation context from workflow state.
   *
   * Populates phase outputs from state artifacts, allowing interpolation
   * of paths like {{ phases.planning.outputs.artifact }} in later phases.
   */
  private buildInterpolationContext(
    definition: WorkflowDefinition,
    state: WorkflowState
  ): InterpolationContext {
    // Build phase outputs map from artifacts
    const phases: Record<string, { outputs?: Record<string, string | undefined> }> = {}

    // Initialize outputs for all phases in the definition
    for (const phaseDef of definition.phases) {
      phases[phaseDef.id] = { outputs: {} }
    }

    // Group artifacts by phase (inferred from artifact path or type)
    for (const artifact of state.artifacts) {
      // Determine which phase this artifact belongs to
      const phaseId = this.inferPhaseFromArtifact(artifact, definition)
      if (!phaseId) continue

      if (!phases[phaseId]) {
        phases[phaseId] = { outputs: {} }
      }

      const outputs = phases[phaseId].outputs as Record<string, string | undefined>

      // Map artifact type to output field
      switch (artifact.type) {
        case 'plan':
        case 'implementation':
          // Store the latest artifact path (may be overwritten by later iterations)
          outputs['artifact'] = artifact.file
          break
        case 'review':
          // Store the review directory (extract directory from file path)
          outputs['reviews'] = path.dirname(artifact.file)
          break
        case 'verification':
          // Store the verification directory
          outputs['verifications'] = path.dirname(artifact.file)
          break
        case 'test-result':
          outputs['artifact'] = artifact.file
          outputs['test_results'] = path.dirname(artifact.file)
          break
      }
    }

    // Also populate from feedback history (review files)
    for (const feedback of state.feedback_history) {
      const phaseId = this.inferPhaseFromFeedback(feedback, definition)
      if (!phaseId) continue

      if (!phases[phaseId]) {
        phases[phaseId] = { outputs: {} }
      }

      const outputs = phases[phaseId].outputs as Record<string, string | undefined>
      outputs['reviews'] = path.dirname(feedback.feedback_file)
    }

    return {
      variables: definition.variables || {},
      iteration: state.iteration,
      phase: state.phase,
      phases,
    }
  }

  /**
   * Infer which phase an artifact belongs to based on its path or type.
   */
  private inferPhaseFromArtifact(
    artifact: import('src/types/WorkflowState').ArtifactRecord,
    definition: WorkflowDefinition
  ): string | undefined {
    // Check if artifact path contains a phase ID
    for (const phase of definition.phases) {
      // Check if the path contains the phase id as a directory
      if (artifact.file.includes(`/${phase.id}/`) || artifact.file.includes(`\\${phase.id}\\`)) {
        return phase.id
      }
    }

    // Infer from artifact type
    switch (artifact.type) {
      case 'plan':
        // Could be planning or testing-setup (both use plan type currently)
        // Check the creator to distinguish
        if (artifact.created_by.includes('plan') || artifact.created_by === 'plan-creator') {
          return 'planning'
        }
        if (artifact.created_by.includes('test') || artifact.created_by === 'test-writer') {
          return 'testing-setup'
        }
        return 'planning'
      case 'implementation':
        return 'implementation'
      case 'test-result':
        return 'testing-execution'
      case 'verification':
      case 'review':
        // These can belong to any iterative phase, need to check creator
        for (const phase of definition.phases) {
          if (isIterativePhase(phase)) {
            // Check if creator matches verifiers or reviewers
            if (
              phase.verifiers.includes(artifact.created_by) ||
              phase.reviewers.includes(artifact.created_by)
            ) {
              return phase.id
            }
          }
        }
        break
    }

    return undefined
  }

  /**
   * Infer which phase a feedback record belongs to based on the reviewer.
   */
  private inferPhaseFromFeedback(
    feedback: import('src/types/WorkflowState').FeedbackRecord,
    definition: WorkflowDefinition
  ): string | undefined {
    // Check which phase has this reviewer
    for (const phase of definition.phases) {
      if (isIterativePhase(phase)) {
        if (phase.reviewers.includes(feedback.reviewer)) {
          return phase.id
        }
      }
    }
    return undefined
  }

  /**
   * Get default artifact path for a phase.
   */
  private getDefaultArtifactPath(
    definition: WorkflowDefinition,
    phase: PhaseDefinition,
    state: WorkflowState
  ): string {
    const baseDir = definition.output_dir || '.cursor/agents/workflow'
    return path.join(baseDir, phase.id, `${phase.id}-v${state.iteration}.md`)
  }

  /**
   * Get the next phase in the workflow.
   */
  private getNextPhase(
    definition: WorkflowDefinition,
    currentPhaseId: WorkflowPhase
  ): PhaseDefinition | undefined {
    const currentIndex = definition.phases.findIndex((p) => p.id === currentPhaseId)
    if (currentIndex === -1 || currentIndex === definition.phases.length - 1) {
      return undefined
    }
    return definition.phases[currentIndex + 1]
  }
}
