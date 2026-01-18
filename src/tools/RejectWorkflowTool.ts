/**
 * RejectWorkflowTool - MCP tool to reject a workflow at a checkpoint.
 *
 * Used when the human reviewer determines the work is not acceptable
 * and provides detailed feedback for what needs to change.
 */

import { Logger } from 'src/utils/Logger'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'

/**
 * Schema for reject_workflow tool input.
 */
export interface RejectWorkflowInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    workflow_id: {
      type: 'string'
      description: string
    }
    reason: {
      type: 'string'
      description: string
    }
    required_changes: {
      type: 'array'
      items: { type: 'string' }
      description: string
    }
    restart_from: {
      type: 'string'
      enum: string[]
      description: string
    }
  }
  required: string[]
}

/**
 * Validated parameters for reject_workflow execution.
 */
export interface RejectWorkflowParams {
  workflow_id: string
  reason: string
  required_changes?: string[] | undefined
  restart_from?:
    | 'planning'
    | 'implementation'
    | 'testing-setup'
    | 'testing-execution'
    | 'current'
    | undefined
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
 * Tool to reject a workflow at a checkpoint.
 */
export class RejectWorkflowTool {
  public readonly name = 'reject_workflow'
  public readonly description =
    'Rejects a workflow at a checkpoint with detailed feedback. ' +
    'Use when work is not acceptable and needs significant changes.'

  public readonly inputSchema: RejectWorkflowInputSchema = {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
        description: 'The workflow ID to reject',
      },
      reason: {
        type: 'string',
        description: 'Detailed reason for rejection',
      },
      required_changes: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of specific changes required before resubmission',
      },
      restart_from: {
        type: 'string',
        enum: ['planning', 'implementation', 'testing-setup', 'testing-execution', 'current'],
        description:
          'Which phase to restart from. "current" restarts the current phase from iteration 1.',
      },
    },
    required: ['workflow_id', 'reason'],
  }

  private readonly logger: Logger

  constructor(private readonly workflowManager: WorkflowManager) {
    this.logger = new Logger('debug')
  }

  /**
   * Validate and cast input parameters.
   */
  private validateParams(params: unknown): RejectWorkflowParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('Parameters must be an object')
    }

    const p = params as Record<string, unknown>

    if (typeof p['workflow_id'] !== 'string') {
      throw new Error('Workflow ID parameter must be a string')
    }

    if (typeof p['reason'] !== 'string') {
      throw new Error('Reason parameter must be a string')
    }

    if (p['reason'].length < 10) {
      throw new Error(
        'Please provide a more detailed reason for rejection (at least 10 characters)'
      )
    }

    // Validate optional required_changes
    if (p['required_changes'] !== undefined) {
      if (!Array.isArray(p['required_changes'])) {
        throw new Error('Required changes must be an array if provided')
      }
      for (const [index, change] of p['required_changes'].entries()) {
        if (typeof change !== 'string') {
          throw new Error(`Required change at index ${index} must be a string`)
        }
      }
    }

    // Validate optional restart_from
    const validPhases = [
      'planning',
      'implementation',
      'testing-setup',
      'testing-execution',
      'current',
    ]
    if (p['restart_from'] !== undefined) {
      if (typeof p['restart_from'] !== 'string') {
        throw new Error('Restart from parameter must be a string if provided')
      }
      if (!validPhases.includes(p['restart_from'] as string)) {
        throw new Error(`Restart from must be one of: ${validPhases.join(', ')}`)
      }
    }

    return {
      workflow_id: p['workflow_id'] as string,
      reason: p['reason'] as string,
      required_changes: p['required_changes'] as string[] | undefined,
      restart_from: p['restart_from'] as RejectWorkflowParams['restart_from'],
    }
  }

  /**
   * Execute the reject_workflow tool.
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const requestId = `reject_workflow_${Date.now()}`
    this.logger.info('Executing reject_workflow', { requestId })

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

      // Build rejection feedback
      let feedback = `REJECTED: ${validatedParams.reason}`
      if (validatedParams.required_changes && validatedParams.required_changes.length > 0) {
        feedback += `\n\nRequired changes:\n${validatedParams.required_changes.map((c) => `- ${c}`).join('\n')}`
      }

      // Record the rejection
      await this.workflowManager.recordCheckpoint(validatedParams.workflow_id, 'reject', feedback)

      // If restart_from is specified, update the workflow to restart
      let restartMessage = ''
      if (validatedParams.restart_from) {
        const restartPhase =
          validatedParams.restart_from === 'current' ? state.phase : validatedParams.restart_from

        await this.workflowManager.updateWorkflow(validatedParams.workflow_id, {
          phase: restartPhase,
          iteration: 1,
          status: 'idle',
          checkpoint_message: `Rejected at ${state.phase} iteration ${state.iteration}. Restarting from ${restartPhase}.`,
        })

        restartMessage = `\n\n🔄 Workflow will restart from phase: \`${restartPhase}\`, iteration 1`
      }

      // Build response
      let responseText = '# Workflow Rejected\n\n'
      responseText += `**Workflow:** ${validatedParams.workflow_id}\n`
      responseText += `**Phase:** ${state.phase}\n`
      responseText += `**Iteration:** ${state.iteration}\n\n`

      responseText += '## Reason\n\n'
      responseText += `${validatedParams.reason}\n\n`

      if (validatedParams.required_changes && validatedParams.required_changes.length > 0) {
        responseText += '## Required Changes\n\n'
        for (const change of validatedParams.required_changes) {
          responseText += `- [ ] ${change}\n`
        }
        responseText += '\n'
      }

      responseText += `❌ **Workflow marked as rejected.**${restartMessage}\n`

      this.logger.info('Workflow rejected', {
        requestId,
        workflowId: validatedParams.workflow_id,
        reason: validatedParams.reason,
        restartFrom: validatedParams.restart_from,
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
      this.logger.error('Reject workflow failed', undefined, { requestId, error: errorMessage })

      return {
        content: [
          {
            type: 'text',
            text: `Error rejecting workflow: ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }
}
