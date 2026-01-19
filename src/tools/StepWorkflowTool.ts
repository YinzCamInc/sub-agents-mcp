/**
 * StepWorkflowTool - MCP tool to execute the next step in a workflow.
 *
 * Executes one step at a time, allowing for controlled progression
 * through workflow phases with human checkpoints.
 */

import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutor } from 'src/execution/AgentExecutor'
import { Logger } from 'src/utils/Logger'
import { WorkflowExecutor } from 'src/workflow/WorkflowExecutor'
import { WorkflowLoader } from 'src/workflow/WorkflowLoader'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'

/**
 * Schema for step_workflow tool input.
 */
export interface StepWorkflowInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    workflow_id: {
      type: 'string'
      description: string
    }
    workflow_file: {
      type: 'string'
      description: string
    }
  }
  required: string[]
}

/**
 * Validated parameters for step_workflow execution.
 */
export interface StepWorkflowParams {
  workflow_id: string
  workflow_file?: string | undefined
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
 * Tool to execute the next step in a workflow.
 */
export class StepWorkflowTool {
  public readonly name = 'step_workflow'
  public readonly description =
    'Executes the next step in a workflow. ' +
    'Use this to advance through workflow phases one step at a time.'

  public readonly inputSchema: StepWorkflowInputSchema = {
    type: 'object',
    properties: {
      workflow_id: {
        type: 'string',
        description: 'The workflow ID to advance',
      },
      workflow_file: {
        type: 'string',
        description: 'Path to the workflow definition file (required for first step)',
      },
    },
    required: ['workflow_id'],
  }

  private readonly logger: Logger
  private readonly workflowLoader: WorkflowLoader
  private readonly workflowExecutor: WorkflowExecutor

  constructor(
    agentExecutor: AgentExecutor,
    agentManager: AgentManager,
    private readonly workflowManager: WorkflowManager
  ) {
    this.logger = new Logger('debug')
    this.workflowLoader = new WorkflowLoader()
    this.workflowExecutor = new WorkflowExecutor(agentExecutor, agentManager, workflowManager)
  }

  /**
   * Validate and cast input parameters.
   */
  private validateParams(params: unknown): StepWorkflowParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('Parameters must be an object')
    }

    const p = params as Record<string, unknown>

    if (typeof p['workflow_id'] !== 'string') {
      throw new Error('Workflow ID parameter must be a string')
    }

    if (p['workflow_file'] !== undefined && typeof p['workflow_file'] !== 'string') {
      throw new Error('Workflow file must be a string if provided')
    }

    return {
      workflow_id: p['workflow_id'] as string,
      workflow_file: p['workflow_file'] as string | undefined,
    }
  }

  /**
   * Execute the step_workflow tool.
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const requestId = `step_workflow_${Date.now()}`
    this.logger.info('Executing step_workflow', { requestId })

    try {
      const validatedParams = this.validateParams(params)

      // Get workflow state
      const state = await this.workflowManager.getWorkflow(validatedParams.workflow_id)
      if (!state) {
        return {
          content: [
            {
              type: 'text',
              text: `Workflow '${validatedParams.workflow_id}' not found.\n\nUse \`start_workflow\` to create a new workflow.`,
            },
          ],
          isError: true,
        }
      }

      // Check if workflow is at a checkpoint
      if (state.status === 'checkpoint') {
        return {
          content: [
            {
              type: 'text',
              text: `## ⏸️ Workflow at Checkpoint\n\n${state.checkpoint_message || 'Review required before proceeding.'}\n\n**Actions:**\n- Use \`continue_workflow\` with \`decision: "continue"\` to proceed\n- Use \`continue_workflow\` with \`decision: "iterate"\` and feedback to request changes\n- Use \`continue_workflow\` with \`decision: "approve"\` to approve and move to next phase\n- Use \`reject_workflow\` to reject with detailed feedback`,
            },
          ],
          isError: false,
        }
      }

      // Check if workflow is complete
      if (state.status === 'complete') {
        return {
          content: [
            {
              type: 'text',
              text: `## ✨ Workflow Complete\n\nWorkflow '${validatedParams.workflow_id}' has finished all phases.\n\nFinal phase: ${state.phase}, Iteration: ${state.iteration}`,
            },
          ],
          isError: false,
        }
      }

      // Check if workflow is rejected
      if (state.status === 'rejected') {
        return {
          content: [
            {
              type: 'text',
              text: `## ❌ Workflow Rejected\n\nWorkflow '${validatedParams.workflow_id}' was rejected.\n\nTo restart, use \`continue_workflow\` with a restart decision.`,
            },
          ],
          isError: false,
        }
      }

      // Load workflow definition
      let definition: import('src/types/WorkflowDefinition').WorkflowDefinition | undefined
      if (validatedParams.workflow_file) {
        const loadResult = await this.workflowLoader.loadFromFile(validatedParams.workflow_file)
        if (!loadResult.success || !loadResult.definition) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to load workflow definition: ${loadResult.error}`,
              },
            ],
            isError: true,
          }
        }
        definition = loadResult.definition
      } else {
        // Use default definition
        const defaultResult = await this.workflowLoader.createDefaultWorkflow('temp')
        if (!defaultResult.definition) {
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to load default workflow definition',
              },
            ],
            isError: true,
          }
        }
        definition = defaultResult.definition
      }

      // Execute the next step
      const progress = await this.workflowExecutor.executeStep(
        definition,
        validatedParams.workflow_id
      )

      // Build response
      let responseText = '# Workflow Step Executed\n\n'
      responseText += `**Workflow:** ${validatedParams.workflow_id}\n`
      responseText += `**Phase:** ${progress.phase}\n`
      responseText += `**Iteration:** ${progress.iteration}\n`
      responseText += `**Step:** ${progress.step}\n\n`

      responseText += `## Result\n\n${progress.message}\n\n`

      if (progress.artifacts && progress.artifacts.length > 0) {
        responseText += '## Artifacts\n\n'
        for (const artifact of progress.artifacts) {
          responseText += `- \`${artifact}\`\n`
        }
        responseText += '\n'
      }

      if (progress.step === 'checkpoint') {
        responseText += '## Next Steps\n\n'
        responseText += 'The workflow is paused for your review.\n\n'
        responseText += '- Use `continue_workflow` to proceed\n'
        responseText += '- Use `reject_workflow` to request changes\n'
      } else if (progress.step !== 'complete') {
        responseText += '## Next Steps\n\n'
        responseText += 'Use `step_workflow` again to continue to the next step.\n'
      }

      this.logger.info('Workflow step executed', {
        requestId,
        workflowId: validatedParams.workflow_id,
        phase: progress.phase,
        step: progress.step,
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
      this.logger.error('Step workflow failed', undefined, { requestId, error: errorMessage })

      return {
        content: [
          {
            type: 'text',
            text: `Error executing workflow step: ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }
}
