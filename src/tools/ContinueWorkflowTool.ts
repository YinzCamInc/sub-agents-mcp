/**
 * ContinueWorkflowTool - MCP tool to resume a workflow from a checkpoint.
 *
 * Allows the user to:
 * - Continue to the next step
 * - Request another iteration with feedback
 * - Approve the current phase
 */

import type { CheckpointDecision, WorkflowPhase } from 'src/types/WorkflowState'
import { Logger } from 'src/utils/Logger'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'

/**
 * Schema for continue_workflow tool input.
 */
export interface ContinueWorkflowInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    workflow_id: {
      type: 'string'
      description: string
    }
    decision: {
      type: 'string'
      enum: string[]
      description: string
    }
    feedback: {
      type: 'string'
      description: string
    }
    next_phase: {
      type: 'string'
      enum: string[]
      description: string
    }
  }
  required: string[]
}

/**
 * Validated parameters for continue_workflow execution.
 */
export interface ContinueWorkflowParams {
  workflow_id: string
  decision: CheckpointDecision
  feedback?: string | undefined
  next_phase?: WorkflowPhase | undefined
}

/**
 * MCP tool response structure.
 */
export interface McpToolResponse {
  content: Array<{
    type: 'text'
    text: string
  }>
  isError?: boolean
}

/**
 * Tool to resume a workflow from a checkpoint.
 */
export class ContinueWorkflowTool {
  public readonly name = 'continue_workflow'
  public readonly description =
    'Resumes a workflow from a checkpoint. Use to continue, iterate with feedback, or approve the phase.'

  public readonly inputSchema: ContinueWorkflowInputSchema = {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
        description: 'The workflow ID to continue',
      },
      decision: {
        type: 'string',
        enum: ['continue', 'iterate', 'approve'],
        description:
          'Decision: "continue" proceeds to next step, "iterate" starts another iteration with feedback, "approve" completes the phase',
      },
      feedback: {
        type: 'string',
        description: 'Feedback for the iteration (required when decision is "iterate")',
      },
      next_phase: {
        type: 'string',
        enum: ['planning', 'implementation', 'testing-setup', 'testing-execution'],
        description: 'When approving, optionally specify the next phase to transition to',
      },
    },
    required: ['workflow_id', 'decision'],
  }

  private readonly logger: Logger

  constructor(private readonly workflowManager: WorkflowManager) {
    this.logger = new Logger('debug')
  }

  /**
   * Validate and cast input parameters.
   */
  private validateParams(params: unknown): ContinueWorkflowParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('Parameters must be an object')
    }

    const p = params as Record<string, unknown>

    if (typeof p['workflow_id'] !== 'string') {
      throw new Error('Workflow ID parameter must be a string')
    }

    if (typeof p['decision'] !== 'string') {
      throw new Error('Decision parameter must be a string')
    }

    const validDecisions = ['continue', 'iterate', 'approve']
    if (!validDecisions.includes(p['decision'] as string)) {
      throw new Error(`Decision must be one of: ${validDecisions.join(', ')}`)
    }

    // Validate feedback is provided for iterate
    if (p['decision'] === 'iterate' && !p['feedback']) {
      throw new Error('Feedback is required when decision is "iterate"')
    }

    if (p['feedback'] !== undefined && typeof p['feedback'] !== 'string') {
      throw new Error('Feedback parameter must be a string if provided')
    }

    const validPhases = ['planning', 'implementation', 'testing-setup', 'testing-execution']
    if (p['next_phase'] !== undefined) {
      if (typeof p['next_phase'] !== 'string') {
        throw new Error('Next phase parameter must be a string if provided')
      }
      if (!validPhases.includes(p['next_phase'] as string)) {
        throw new Error(`Next phase must be one of: ${validPhases.join(', ')}`)
      }
    }

    return {
      workflow_id: p['workflow_id'] as string,
      decision: p['decision'] as CheckpointDecision,
      feedback: p['feedback'] as string | undefined,
      next_phase: p['next_phase'] as WorkflowPhase | undefined,
    }
  }

  /**
   * Execute the continue_workflow tool.
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const requestId = `continue_workflow_${Date.now()}`
    this.logger.info('Executing continue_workflow', { requestId })

    try {
      // Validate parameters
      const validatedParams = this.validateParams(params)

      // Get workflow state
      const state = await this.workflowManager.getWorkflow(validatedParams.workflow_id)
      if (!state) {
        return {
          content: [
            {
              type: 'text',
              text: `Workflow '${validatedParams.workflow_id}' not found.`,
            },
          ],
          isError: true,
        }
      }

      // Check if workflow is at a checkpoint
      if (state.status !== 'checkpoint') {
        return {
          content: [
            {
              type: 'text',
              text: `Workflow '${validatedParams.workflow_id}' is not at a checkpoint.\n\nCurrent status: ${state.status}`,
            },
          ],
          isError: true,
        }
      }

      // Record the checkpoint decision
      let updatedState = await this.workflowManager.recordCheckpoint(
        validatedParams.workflow_id,
        validatedParams.decision,
        validatedParams.feedback
      )

      // Special handling for test-execution phase with 'iterate' decision
      // In test-execution, 'iterate' means "run the fixer agent", not "start a new iteration"
      // So we set status to 'verifying' which triggers the fixer step
      if (validatedParams.decision === 'iterate' && state.phase === 'testing-execution') {
        // Revert the iteration increment that recordCheckpoint did
        // because we want to stay in the same iteration until fixer completes
        updatedState = await this.workflowManager.updateWorkflow(validatedParams.workflow_id, {
          iteration: state.iteration, // Keep same iteration
          status: 'verifying', // This triggers fixer agent in executeTestExecutionStep
        })
      }

      // If approving and next_phase is specified, transition to it
      if (validatedParams.decision === 'approve' && validatedParams.next_phase) {
        updatedState = await this.workflowManager.updateWorkflow(validatedParams.workflow_id, {
          phase: validatedParams.next_phase,
          iteration: 1,
          status: 'working',
        })
      }

      // Build response
      let responseText = '# Workflow Continued\n\n'
      responseText += `**Workflow:** ${validatedParams.workflow_id}\n`
      responseText += `**Decision:** ${validatedParams.decision}\n\n`

      switch (validatedParams.decision) {
        case 'continue':
          responseText += '✅ Workflow resumed. Proceeding to next step.\n\n'
          responseText += `Current state: Phase \`${updatedState.phase}\`, Iteration ${updatedState.iteration}\n`
          break

        case 'iterate':
          if (state.phase === 'testing-execution') {
            responseText += '🔧 Running fixer agent to address test failures.\n\n'
            responseText += `**Feedback:** ${validatedParams.feedback}\n\n`
            responseText +=
              'The fixer agent will attempt to fix the failing tests, then tests will be re-run.\n'
          } else {
            responseText += `🔁 Starting iteration ${updatedState.iteration} with feedback.\n\n`
            responseText += `**Feedback:** ${validatedParams.feedback}\n\n`
            responseText += 'The agents should now incorporate this feedback.\n'
          }
          break

        case 'approve':
          if (validatedParams.next_phase) {
            responseText += `✨ Phase \`${state.phase}\` approved!\n\n`
            responseText += `Transitioning to phase: \`${validatedParams.next_phase}\`\n`
          } else {
            responseText += `✨ Phase \`${state.phase}\` approved and marked complete!\n`
          }
          break
      }

      this.logger.info('Workflow continued', {
        requestId,
        workflowId: validatedParams.workflow_id,
        decision: validatedParams.decision,
        newIteration: updatedState.iteration,
      })

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        isError: false,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error('Continue workflow failed', undefined, { requestId, error: errorMessage })

      return {
        content: [
          {
            type: 'text',
            text: `Error continuing workflow: ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }
}
