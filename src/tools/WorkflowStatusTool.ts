/**
 * WorkflowStatusTool - MCP tool to display current workflow state.
 *
 * Shows:
 * - Current phase and iteration
 * - Status and checkpoint message
 * - Recent artifacts and feedback
 * - Agent run history
 */

import type { WorkflowState } from 'src/types/WorkflowState'
import { Logger } from 'src/utils/Logger'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'

/**
 * Schema for workflow_status tool input.
 */
export interface WorkflowStatusInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    workflow_id: {
      type: 'string'
      description: string
    }
    verbose: {
      type: 'boolean'
      description: string
    }
  }
  required: string[]
}

/**
 * Validated parameters for workflow_status execution.
 */
export interface WorkflowStatusParams {
  workflow_id: string
  verbose?: boolean | undefined
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
 * Tool to display current workflow state.
 */
export class WorkflowStatusTool {
  public readonly name = 'workflow_status'
  public readonly description =
    'Shows the current status of a workflow including phase, iteration, ' +
    'recent artifacts, feedback, and checkpoint state.'

  public readonly inputSchema: WorkflowStatusInputSchema = {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
        description: 'The workflow ID to check status for',
      },
      verbose: {
        type: 'boolean',
        description: 'If true, show full history details (default: false)',
      },
    },
    required: ['workflow_id'],
  }

  private readonly logger: Logger

  constructor(private readonly workflowManager: WorkflowManager) {
    this.logger = new Logger('debug')
  }

  /**
   * Validate and cast input parameters.
   */
  private validateParams(params: unknown): WorkflowStatusParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('Parameters must be an object')
    }

    const p = params as Record<string, unknown>

    if (typeof p['workflow_id'] !== 'string') {
      throw new Error('Workflow ID parameter must be a string')
    }

    if (p['verbose'] !== undefined && typeof p['verbose'] !== 'boolean') {
      throw new Error('Verbose parameter must be a boolean if provided')
    }

    return {
      workflow_id: p['workflow_id'] as string,
      verbose: p['verbose'] as boolean | undefined,
    }
  }

  /**
   * Format workflow state as readable text.
   */
  private formatWorkflowStatus(state: WorkflowState, verbose: boolean): string {
    let text = `# Workflow Status: ${state.workflow_id}\n\n`

    // Status badge
    const statusEmoji = {
      idle: '⏸️',
      working: '🔄',
      reviewing: '👀',
      verifying: '✅',
      checkpoint: '🚧',
      complete: '✨',
      rejected: '❌',
    }[state.status]

    text += '## Overview\n\n'
    text += '| Property | Value |\n'
    text += '|----------|-------|\n'
    text += `| Status | ${statusEmoji} ${state.status} |\n`
    text += `| Phase | ${state.phase} |\n`
    text += `| Iteration | ${state.iteration} |\n`
    text += `| Created | ${state.created_at} |\n`
    text += `| Updated | ${state.updated_at} |\n`
    text += '\n'

    // Checkpoint message
    if (state.status === 'checkpoint' && state.checkpoint_message) {
      text += '## ⏸️ Checkpoint\n\n'
      text += `> ${state.checkpoint_message}\n\n`
      text += '**Actions available:**\n'
      text += '- `continue_workflow` - Resume from this checkpoint\n'
      text += '- `reject_workflow` - Reject and provide feedback\n\n'
    }

    // Current artifact
    if (state.current_artifact) {
      text += '## Current Artifact\n\n'
      text += `\`${state.current_artifact}\`\n\n`
    }

    // Recent artifacts
    if (state.artifacts.length > 0) {
      const recentArtifacts = verbose ? state.artifacts : state.artifacts.slice(-5)
      text += `## Artifacts (${verbose ? 'all' : `last ${recentArtifacts.length}`})\n\n`
      text += '| Iteration | Type | File | Created By |\n'
      text += '|-----------|------|------|------------|\n'
      for (const artifact of recentArtifacts) {
        text += `| ${artifact.iteration} | ${artifact.type} | \`${artifact.file}\` | ${artifact.created_by} |\n`
      }
      text += '\n'
    }

    // Feedback history
    const unaddressed = state.feedback_history.filter((f) => !f.addressed)
    if (unaddressed.length > 0) {
      text += `## ⚠️ Unaddressed Feedback (${unaddressed.length})\n\n`
      for (const feedback of unaddressed) {
        text += `- **${feedback.reviewer}** (iteration ${feedback.iteration}): \`${feedback.feedback_file}\`\n`
      }
      text += '\n'
    }

    if (verbose && state.feedback_history.length > 0) {
      text += '## Feedback History\n\n'
      text += '| Iteration | Reviewer | File | Addressed |\n'
      text += '|-----------|----------|------|----------|\n'
      for (const feedback of state.feedback_history) {
        const addressed = feedback.addressed ? '✅' : '❌'
        text += `| ${feedback.iteration} | ${feedback.reviewer} | \`${feedback.feedback_file}\` | ${addressed} |\n`
      }
      text += '\n'
    }

    // Checkpoints passed
    if (state.checkpoints_passed.length > 0) {
      const recentCheckpoints = verbose
        ? state.checkpoints_passed
        : state.checkpoints_passed.slice(-3)
      text += `## Checkpoints (${verbose ? 'all' : `last ${recentCheckpoints.length}`})\n\n`
      for (const checkpoint of recentCheckpoints) {
        const decisionEmoji = {
          continue: '▶️',
          iterate: '🔁',
          approve: '✅',
          reject: '❌',
        }[checkpoint.decision]
        text += `- **Iteration ${checkpoint.iteration}**: ${decisionEmoji} ${checkpoint.decision}`
        if (checkpoint.feedback) {
          text += ` - "${checkpoint.feedback}"`
        }
        text += '\n'
      }
      text += '\n'
    }

    // Agent runs
    if (verbose && state.agent_runs.length > 0) {
      text += '## Agent Runs\n\n'
      text += '| Agent | Iteration | Success | Duration |\n'
      text += '|-------|-----------|---------|----------|\n'
      for (const run of state.agent_runs.slice(-10)) {
        const success = run.success === undefined ? '⏳' : run.success ? '✅' : '❌'
        const duration =
          run.completed_at && run.started_at
            ? `${new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()}ms`
            : 'running'
        text += `| ${run.agent} | ${run.iteration} | ${success} | ${duration} |\n`
      }
      text += '\n'
    }

    return text
  }

  /**
   * Execute the workflow_status tool.
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const requestId = `workflow_status_${Date.now()}`
    this.logger.info('Executing workflow_status', { requestId })

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
              text: `Workflow '${validatedParams.workflow_id}' not found.\n\nUse \`run_agent\` with a \`workflow_id\` parameter to create a new workflow.`,
            },
          ],
          isError: true,
        }
      }

      // Format status
      const statusText = this.formatWorkflowStatus(state, validatedParams.verbose ?? false)

      this.logger.info('Workflow status retrieved', {
        requestId,
        workflowId: validatedParams.workflow_id,
        status: state.status,
      })

      return {
        content: [
          {
            type: 'text',
            text: statusText,
          },
        ],
        isError: false,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error('Workflow status failed', undefined, { requestId, error: errorMessage })

      return {
        content: [
          {
            type: 'text',
            text: `Error getting workflow status: ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }
}
