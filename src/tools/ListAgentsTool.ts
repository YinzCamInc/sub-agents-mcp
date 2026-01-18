/**
 * ListAgentsTool implementation for listing available agents via MCP
 *
 * Provides the list_agents tool that allows MCP clients to discover available
 * agent definitions, including their names, descriptions, and configured models.
 */

import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentModelId } from 'src/types/AgentDefinition'
import { type LogLevel, Logger } from 'src/utils/Logger'

/**
 * MCP tool content type for text responses
 */
interface McpTextContent {
  [x: string]: unknown
  type: 'text'
  text: string
}

/**
 * MCP tool response format
 */
interface McpToolResponse {
  [x: string]: unknown
  content: McpTextContent[]
  isError?: boolean
  structuredContent?: unknown
}

/**
 * Agent summary for list response
 */
interface AgentSummary {
  name: string
  description: string
  model: AgentModelId
}

/**
 * Input schema for list_agents tool parameters
 */
interface ListAgentsInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    filter?: {
      type: 'string'
      description: string
    }
  }
  required: string[]
}

/**
 * Parameters for list_agents tool execution
 */
interface ListAgentsParams {
  filter?: string | undefined
}

/**
 * ListAgentsTool class implementing the list_agents MCP tool
 *
 * Provides discovery of available agent definitions with their
 * metadata including name, description, and configured model.
 */
export class ListAgentsTool {
  public readonly name = 'list_agents'
  public readonly description =
    'List all available agent definitions with their names, descriptions, and configured models. Use this to discover agents before running them with run_agent.'
  private logger: Logger

  public readonly inputSchema: ListAgentsInputSchema = {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description:
          'Optional filter to search agents by name or description (case-insensitive substring match)',
      },
    },
    required: [],
  }

  constructor(private agentManager: AgentManager) {
    // Use LOG_LEVEL environment variable if available
    const logLevel = (process.env['LOG_LEVEL'] as LogLevel) || 'info'
    this.logger = new Logger(logLevel)
  }

  /**
   * Execute the list_agents tool
   *
   * @param params - Tool execution parameters
   * @returns Promise resolving to MCP tool response with list of agents
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const startTime = Date.now()
    const requestId = this.generateRequestId()

    this.logger.info('List agents tool execution started', {
      requestId,
      timestamp: new Date().toISOString(),
    })

    try {
      // Validate parameters
      const validatedParams = this.validateParams(params)

      // Get all agents from manager
      const agents = await this.agentManager.listAgents()

      // Apply filter if provided
      let filteredAgents = agents
      if (validatedParams.filter) {
        const filterLower = validatedParams.filter.toLowerCase()
        filteredAgents = agents.filter(
          (agent) =>
            agent.name.toLowerCase().includes(filterLower) ||
            agent.description.toLowerCase().includes(filterLower)
        )
      }

      // Map to summary format
      const agentSummaries: AgentSummary[] = filteredAgents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        model: agent.model,
      }))

      // Sort by name
      agentSummaries.sort((a, b) => a.name.localeCompare(b.name))

      const executionTime = Date.now() - startTime

      this.logger.info('List agents completed', {
        requestId,
        totalAgents: agents.length,
        filteredAgents: agentSummaries.length,
        filter: validatedParams.filter || 'none',
        executionTime,
      })

      // Build response
      const responseData = {
        agents: agentSummaries,
        total: agentSummaries.length,
        filter: validatedParams.filter || null,
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(responseData, null, 2),
          },
        ],
        structuredContent: responseData,
      }
    } catch (error) {
      const executionTime = Date.now() - startTime

      this.logger.error('List agents failed', error instanceof Error ? error : undefined, {
        requestId,
        executionTime,
      })

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: error instanceof Error ? error.message : 'Unknown error',
                status: 'error',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      }
    }
  }

  /**
   * Validate and type-check the input parameters
   *
   * @private
   * @param params - Raw parameters to validate
   * @returns Validated parameters
   */
  private validateParams(params: unknown): ListAgentsParams {
    if (params === undefined || params === null) {
      return {}
    }

    if (typeof params !== 'object') {
      return {}
    }

    const p = params as Record<string, unknown>

    // Validate optional filter parameter
    if (p['filter'] !== undefined) {
      if (typeof p['filter'] !== 'string') {
        throw new Error('Filter parameter must be a string if provided')
      }

      if (p['filter'].length > 200) {
        throw new Error('Filter too long (max 200 characters)')
      }
    }

    return {
      filter: p['filter'] as string | undefined,
    }
  }

  /**
   * Generate unique request ID for tracking
   *
   * @private
   * @returns Unique request identifier
   */
  private generateRequestId(): string {
    return `list_agents_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}
