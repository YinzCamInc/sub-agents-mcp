/**
 * StartWorkflowTool - MCP tool to start a workflow from a YAML definition.
 *
 * Loads a workflow definition, creates workflow state, and begins execution.
 */

import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutor } from 'src/execution/AgentExecutor'
import { Logger } from 'src/utils/Logger'
import { WorkflowExecutor } from 'src/workflow/WorkflowExecutor'
import { WorkflowLoader } from 'src/workflow/WorkflowLoader'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'

/**
 * Schema for start_workflow tool input.
 */
export interface StartWorkflowInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    workflow_file: {
      type: 'string'
      description: string
    }
    workflow_id: {
      type: 'string'
      description: string
    }
    input_file: {
      type: 'string'
      description: string
    }
    use_default: {
      type: 'boolean'
      description: string
    }
  }
  required: string[]
}

/**
 * Validated parameters for start_workflow execution.
 */
export interface StartWorkflowParams {
  workflow_file?: string | undefined
  workflow_id?: string | undefined
  input_file?: string | undefined
  use_default?: boolean | undefined
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
 * Tool to start a workflow from a YAML definition.
 */
export class StartWorkflowTool {
  public readonly name = 'start_workflow'
  public readonly description =
    'Starts a new workflow from a YAML definition file. ' +
    'Initializes workflow state and begins execution at the first phase.'

  public readonly inputSchema: StartWorkflowInputSchema = {
    type: 'object',
    properties: {
      workflow_file: {
        type: 'string',
        description:
          'Path to the workflow YAML file (relative to .cursor/agents/workflows/ or absolute)',
      },
      workflow_id: {
        type: 'string',
        description: 'Custom workflow ID (defaults to workflow name + timestamp)',
      },
      input_file: {
        type: 'string',
        description: 'Initial input file (e.g., requirements.md) to provide as context',
      },
      use_default: {
        type: 'boolean',
        description: 'Use the default workflow definition if workflow_file not specified',
      },
    },
    required: [],
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
  private validateParams(params: unknown): StartWorkflowParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('Parameters must be an object')
    }

    const p = params as Record<string, unknown>

    if (p['workflow_file'] !== undefined && typeof p['workflow_file'] !== 'string') {
      throw new Error('Workflow file must be a string if provided')
    }

    if (p['workflow_id'] !== undefined && typeof p['workflow_id'] !== 'string') {
      throw new Error('Workflow ID must be a string if provided')
    }

    if (p['input_file'] !== undefined && typeof p['input_file'] !== 'string') {
      throw new Error('Input file must be a string if provided')
    }

    if (p['use_default'] !== undefined && typeof p['use_default'] !== 'boolean') {
      throw new Error('Use default must be a boolean if provided')
    }

    return {
      workflow_file: p['workflow_file'] as string | undefined,
      workflow_id: p['workflow_id'] as string | undefined,
      input_file: p['input_file'] as string | undefined,
      use_default: p['use_default'] as boolean | undefined,
    }
  }

  /**
   * Execute the start_workflow tool.
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const requestId = `start_workflow_${Date.now()}`
    this.logger.info('Executing start_workflow', { requestId })

    try {
      const validatedParams = this.validateParams(params)

      // Load or create workflow definition
      let loadResult:
        | Awaited<ReturnType<typeof this.workflowLoader.loadFromFile>>
        | Awaited<ReturnType<typeof this.workflowLoader.createDefaultWorkflow>>

      if (validatedParams.workflow_file) {
        loadResult = await this.workflowLoader.loadFromFile(validatedParams.workflow_file)
      } else if (validatedParams.use_default) {
        const defaultName = `workflow-${Date.now()}`
        loadResult = await this.workflowLoader.createDefaultWorkflow(defaultName)
      } else {
        return {
          content: [
            {
              type: 'text',
              text:
                'Error: Must provide either `workflow_file` or set `use_default: true`\n\n' +
                'Example usage:\n' +
                '- `start_workflow({ workflow_file: "my-workflow.yaml" })`\n' +
                '- `start_workflow({ use_default: true })`',
            },
          ],
          isError: true,
        }
      }

      if (!loadResult.success || !loadResult.definition) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to load workflow: ${loadResult.error}`,
            },
          ],
          isError: true,
        }
      }

      const definition = loadResult.definition

      // Generate workflow ID
      const workflowId =
        validatedParams.workflow_id || `${definition.name}-${Date.now().toString(36)}`

      // Check if workflow already exists
      const existing = await this.workflowManager.getWorkflow(workflowId)
      if (existing) {
        return {
          content: [
            {
              type: 'text',
              text: `Workflow '${workflowId}' already exists (status: ${existing.status}).\n\nUse \`workflow_status\` to check its state, or choose a different workflow_id.`,
            },
          ],
          isError: true,
        }
      }

      // Start the workflow
      const state = await this.workflowExecutor.startWorkflow(
        definition,
        workflowId,
        validatedParams.input_file
      )

      // Build response
      let responseText = '# Workflow Started\n\n'
      responseText += `**Workflow ID:** \`${workflowId}\`\n`
      responseText += `**Definition:** ${definition.name} (v${definition.version})\n`
      if (definition.description) {
        responseText += `**Description:** ${definition.description}\n`
      }
      responseText += '\n'

      responseText += '## Phases\n\n'
      for (const [index, phase] of definition.phases.entries()) {
        const isCurrent = phase.id === state.phase
        const marker = isCurrent ? '➡️' : '  '
        responseText += `${marker} ${index + 1}. **${phase.id}** (${phase.type})\n`
      }
      responseText += '\n'

      responseText += '## Current Status\n\n'
      responseText += `- **Phase:** ${state.phase}\n`
      responseText += `- **Iteration:** ${state.iteration}\n`
      responseText += `- **Status:** ${state.status}\n`
      responseText += '\n'

      responseText += '## Next Steps\n\n'
      responseText += '1. Use `workflow_status` to see current state\n'
      responseText += '2. The workflow will pause at checkpoints for your review\n'
      responseText +=
        '3. Use `continue_workflow` to proceed or `reject_workflow` to request changes\n'

      this.logger.info('Workflow started', {
        requestId,
        workflowId,
        definition: definition.name,
        phase: state.phase,
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
      this.logger.error('Start workflow failed', undefined, { requestId, error: errorMessage })

      return {
        content: [
          {
            type: 'text',
            text: `Error starting workflow: ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }
}
