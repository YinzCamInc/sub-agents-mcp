/**
 * RunAgentTool implementation for executing Claude Code sub-agents via MCP
 *
 * Provides the run_agent tool that allows MCP clients to execute specific
 * agents with parameters, integrating with AgentExecutor and AgentManager
 * for complete agent execution workflow.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'
import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutionResult, AgentExecutor } from 'src/execution/AgentExecutor'
import { formatSessionHistory } from 'src/session/SessionHistoryFormatter'
import type { SessionManager } from 'src/session/SessionManager'
import { type AgentDefinition, type AgentModelId, MODEL_MAP } from 'src/types/AgentDefinition'
import type { ExecutionParams } from 'src/types/ExecutionParams'
import { type LogLevel, Logger } from 'src/utils/Logger'
import { validateTokenBudget } from 'src/utils/TokenBudget'

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
  _meta?: {
    session_id: string
  }
}

/**
 * MCP response data structure (ADR-0003)
 * This structure is used in both content[0].text (as JSON string) and structuredContent
 */
interface McpResponseData {
  result: string
  session_id?: string
  agent: string
  exit_code: number
  execution_time: number
  status: 'success' | 'partial' | 'error'
  request_id?: string
  output_path?: string
}

/**
 * Input schema for run_agent tool parameters
 */
interface RunAgentInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    agent: {
      type: 'string'
      description: string
    }
    prompt: {
      type: 'string'
      description: string
    }
    cwd: {
      type: 'string'
      description: string
    }
    extra_args: {
      type: 'array'
      items: { type: 'string' }
      description: string
    }
    session_id: {
      type: 'string'
      description: string
    }
    output: {
      type: 'string'
      description: string
    }
    model: {
      type: 'string'
      description: string
    }
    context_files: {
      type: 'array'
      items: { type: 'string' }
      description: string
    }
    context_globs: {
      type: 'array'
      items: { type: 'string' }
      description: string
    }
    context_data: {
      type: 'object'
      description: string
    }
  }
  required: string[]
}

/**
 * Parameters for run_agent tool execution
 */
interface RunAgentParams {
  agent: string
  prompt: string
  cwd: string
  extra_args?: string[] | undefined
  /**
   * Session ID for continuing previous conversation context (optional)
   *
   * When provided, the agent will have access to previous request/response history.
   * Must be alphanumeric with hyphens and underscores only (max 100 characters).
   */
  session_id?: string | undefined
  /**
   * Output file path to save the agent's response (optional)
   *
   * When provided, the agent's response will be written to this file.
   */
  output?: string | undefined
  /**
   * Model override for agent execution (optional)
   *
   * If provided, overrides the model specified in the agent's frontmatter.
   * Valid values: 'claude-opus-4', 'claude-sonnet-4', 'gpt-5-codex'
   */
  model?: string | undefined
  /**
   * Context files to include in the prompt (optional)
   *
   * List of file paths whose content will be read and appended to the prompt.
   */
  context_files?: string[] | undefined
  /**
   * Glob patterns for context files (optional)
   *
   * Glob patterns (e.g., "reviews/*.md") that will be expanded and their contents
   * appended to the prompt.
   */
  context_globs?: string[] | undefined
  /**
   * Structured context data to include in the prompt (optional)
   *
   * Object containing structured data (iteration, task, etc.) that will be
   * JSON-serialized and included in the context section of the prompt.
   */
  context_data?: Record<string, unknown> | undefined
}

/**
 * RunAgentTool class implementing the run_agent MCP tool
 *
 * Provides execution of Claude Code sub-agents with parameter validation,
 * error handling, and proper MCP response formatting.
 */
export class RunAgentTool {
  public readonly name = 'run_agent'
  public readonly description =
    'Delegate complex, multi-step, or specialized tasks to an autonomous agent for independent execution with dedicated context (e.g., refactoring across multiple files, fixing all test failures, systematic codebase analysis, batch operations). Returns session_id in response metadata - reuse it in subsequent calls to maintain conversation context continuity across multiple agent executions.'
  private logger: Logger
  private executionStats: Map<string, { count: number; totalTime: number; lastUsed: Date }> =
    new Map()

  public readonly inputSchema: RunAgentInputSchema = {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Agent name exactly as listed in list_agents resource or tool.',
      },
      prompt: {
        type: 'string',
        description:
          "User's direct request content. Agent context is separately provided via agent parameter.",
      },
      cwd: {
        type: 'string',
        description:
          'Working directory path for agent execution context. Must be an absolute path to a valid directory.',
      },
      extra_args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional configuration parameters for agent execution (optional)',
      },
      session_id: {
        type: 'string',
        description:
          'Session ID for continuing previous conversation context (optional). If omitted, a new session will be auto-generated and returned in response metadata. Reuse the returned session_id in subsequent calls to maintain context continuity.',
      },
      output: {
        type: 'string',
        description:
          'Output file path to save the agent response (optional). If provided, the result will be written to this file.',
      },
      model: {
        type: 'string',
        description:
          "Model override for agent execution (optional). Overrides the model from agent's frontmatter. Valid values: 'claude-opus-4-5' (Opus 4.5), 'claude-sonnet-4-5' (Sonnet 4.5), 'gpt-5-2-codex' (GPT-5.2 Codex).",
      },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of file paths to include as context (optional). Contents will be read and appended to the prompt.',
      },
      context_globs: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Glob patterns for context files (optional). Patterns like "reviews/*.md" will be expanded and all matching files included as context.',
      },
      context_data: {
        type: 'object',
        description:
          'Structured context data (optional). Object containing iteration, task, phase, or other structured data to pass to the agent.',
      },
    },
    required: ['agent', 'prompt', 'cwd'],
  }

  constructor(
    private agentExecutor?: AgentExecutor,
    private agentManager?: AgentManager,
    private sessionManager?: SessionManager
  ) {
    // Use LOG_LEVEL environment variable if available
    const logLevel = (process.env['LOG_LEVEL'] as LogLevel) || 'info'
    this.logger = new Logger(logLevel)
  }

  /**
   * Execute the run_agent tool with the provided parameters
   *
   * @param params - Tool execution parameters
   * @returns Promise resolving to MCP tool response
   * @throws {Error} When parameters are invalid or execution fails
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const startTime = Date.now()
    const requestId = this.generateRequestId()

    this.logger.info('Run agent tool execution started', {
      requestId,
      timestamp: new Date().toISOString(),
    })

    // Best-effort cleanup: old session files (ADR-0002)
    // Non-blocking execution - does not affect main processing flow
    if (this.sessionManager) {
      Promise.resolve()
        .then(() => this.sessionManager!.cleanupOldSessions())
        .catch((error) => {
          this.logger.warn('Session cleanup failed (best-effort)', {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }

    try {
      // Validate parameters with enhanced validation
      const validatedParams = this.validateParams(params)

      // Auto-generate session_id if not provided and SessionManager is available
      const sessionId =
        validatedParams.session_id || (this.sessionManager ? randomUUID() : undefined)

      this.logger.debug('Parameters validated successfully', {
        requestId,
        agent: validatedParams.agent,
        promptLength: validatedParams.prompt.length,
        cwd: validatedParams.cwd,
        extraArgsCount: validatedParams.extra_args?.length || 0,
        sessionId: sessionId,
        sessionIdGenerated: !validatedParams.session_id && !!sessionId,
      })

      // Check if agent exists and load agent definition once
      let agentDefinition: AgentDefinition | undefined
      if (this.agentManager) {
        agentDefinition = await this.agentManager.getAgent(validatedParams.agent)
        if (!agentDefinition) {
          this.logger.warn('Agent not found', {
            requestId,
            requestedAgent: validatedParams.agent,
          })

          return this.createErrorResponse(
            `Agent '${validatedParams.agent}' not found`,
            await this.getAvailableAgentsList()
          )
        }

        this.logger.debug('Agent found and validated', {
          requestId,
          agentName: agentDefinition.name,
          agentDescription: agentDefinition.description,
          agentModel: agentDefinition.model,
        })
      }

      // Execute agent if executor is available
      if (this.agentExecutor) {
        // Report progress: Starting agent execution

        // Use agent definition content if available (already loaded above)
        const agentContext = agentDefinition?.content ?? validatedParams.agent

        // Determine model: override > agent frontmatter > default
        let modelApiName: string | undefined
        if (validatedParams.model) {
          // User provided model override
          modelApiName = MODEL_MAP[validatedParams.model as AgentModelId]
          this.logger.debug('Using model override', {
            requestId,
            modelId: validatedParams.model,
            modelApiName,
          })
        } else if (agentDefinition?.model) {
          // Use model from agent frontmatter
          modelApiName = MODEL_MAP[agentDefinition.model]
          this.logger.debug('Using model from agent frontmatter', {
            requestId,
            modelId: agentDefinition.model,
            modelApiName,
          })
        }

        // Build context section from files, globs, and data
        const contextSections: string[] = []

        // Read and append context files to prompt
        if (validatedParams.context_files && validatedParams.context_files.length > 0) {
          for (const filePath of validatedParams.context_files) {
            try {
              const resolvedPath = path.isAbsolute(filePath)
                ? filePath
                : path.resolve(validatedParams.cwd, filePath)
              const content = await fs.promises.readFile(resolvedPath, 'utf-8')
              contextSections.push(`## File: ${filePath}\n\`\`\`\n${content}\n\`\`\``)
              this.logger.debug('Context file loaded', {
                requestId,
                filePath: resolvedPath,
                contentLength: content.length,
              })
            } catch (error) {
              this.logger.warn('Failed to read context file', {
                requestId,
                filePath,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }

        // Expand glob patterns and read matching files
        if (validatedParams.context_globs && validatedParams.context_globs.length > 0) {
          for (const pattern of validatedParams.context_globs) {
            try {
              const cwd = validatedParams.cwd
              const matches = await glob(pattern, { cwd, nodir: true })
              this.logger.debug('Glob pattern expanded', {
                requestId,
                pattern,
                matchCount: matches.length,
              })

              for (const match of matches) {
                try {
                  const resolvedPath = path.resolve(cwd, match)
                  const content = await fs.promises.readFile(resolvedPath, 'utf-8')
                  contextSections.push(`## File: ${match}\n\`\`\`\n${content}\n\`\`\``)
                  this.logger.debug('Glob match file loaded', {
                    requestId,
                    filePath: match,
                    contentLength: content.length,
                  })
                } catch (error) {
                  this.logger.warn('Failed to read glob match file', {
                    requestId,
                    filePath: match,
                    error: error instanceof Error ? error.message : String(error),
                  })
                }
              }
            } catch (error) {
              this.logger.warn('Failed to expand glob pattern', {
                requestId,
                pattern,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }

        // Add structured context data
        if (validatedParams.context_data) {
          contextSections.push(
            `## Context Data\n\`\`\`json\n${JSON.stringify(validatedParams.context_data, null, 2)}\n\`\`\``
          )
          this.logger.debug('Context data added', {
            requestId,
            keys: Object.keys(validatedParams.context_data),
          })
        }

        // Build final prompt with context
        let promptWithContext = validatedParams.prompt
        if (contextSections.length > 0) {
          promptWithContext = `# Context\n\n${contextSections.join('\n\n')}\n\n---\n\n# Instructions\n\n${validatedParams.prompt}`
        }

        // Load session history if session_id is provided and SessionManager is available
        let promptWithHistory = promptWithContext
        if (sessionId && this.sessionManager) {
          try {
            // CRITICAL: Pass agent_type to enforce sub-agent isolation
            const sessionData = await this.sessionManager.loadSession(
              sessionId,
              validatedParams.agent
            )
            if (sessionData && sessionData.history.length > 0) {
              // Convert session history to Markdown format for token efficiency and LLM comprehension
              const historyMarkdown = formatSessionHistory(sessionData)
              promptWithHistory = `Previous conversation history:\n\n${historyMarkdown}\n\n---\n\nCurrent request:\n${validatedParams.prompt}`

              this.logger.info('Session history loaded and merged', {
                requestId,
                sessionId: sessionId,
                historyEntries: sessionData.history.length,
              })
            } else {
              this.logger.debug('No session history found', {
                requestId,
                sessionId: sessionId,
              })
            }
          } catch (error) {
            // Log error but continue - session loading failure should not break main flow
            this.logger.warn('Failed to load session history', {
              requestId,
              sessionId: sessionId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        // Check token budget with model-specific limits
        const totalContext = promptWithHistory + (agentContext || '')
        const budgetValidation = validateTokenBudget(
          totalContext,
          modelApiName || agentDefinition?.model
        )
        let tokenWarning: string | undefined

        if (budgetValidation.error) {
          tokenWarning = budgetValidation.error
          if (budgetValidation.recommendation) {
            tokenWarning += `\n\n${budgetValidation.recommendation}`
          }
          this.logger.warn('Context size exceeds limit', {
            requestId,
            tokens: budgetValidation.estimate.tokens,
            limit: budgetValidation.estimate.limit,
            percentage: `${Math.round(budgetValidation.estimate.percentage * 100)}%`,
            model: budgetValidation.estimate.model,
          })
        } else if (budgetValidation.warning) {
          tokenWarning = budgetValidation.warning
          this.logger.info('Context size approaching limit', {
            requestId,
            tokens: budgetValidation.estimate.tokens,
            limit: budgetValidation.estimate.limit,
            percentage: `${Math.round(budgetValidation.estimate.percentage * 100)}%`,
            model: budgetValidation.estimate.model,
          })
        }

        const executionParams: ExecutionParams = {
          agent: agentContext,
          prompt: promptWithHistory,
          ...(validatedParams.cwd !== undefined && { cwd: validatedParams.cwd }),
          ...(validatedParams.extra_args !== undefined && {
            extra_args: validatedParams.extra_args,
          }),
          ...(modelApiName !== undefined && { model: modelApiName }),
        }

        // Report progress: Executing agent

        // Execute agent (this has its own timeout: MCP -> AI)
        const result = await this.agentExecutor.executeAgent(executionParams)

        // Report progress: Execution completed

        // Update execution statistics
        this.updateExecutionStats(validatedParams.agent, result.executionTime)

        this.logger.info('Agent execution completed successfully', {
          requestId,
          agent: validatedParams.agent,
          exitCode: result.exitCode,
          executionTime: result.executionTime,
          totalTime: Date.now() - startTime,
        })

        // Save session if session_id is available and SessionManager is available
        if (sessionId && this.sessionManager) {
          try {
            // Build request object with only defined properties
            const sessionRequest: {
              agent: string
              prompt: string
              cwd?: string
              extra_args?: string[]
            } = {
              agent: validatedParams.agent,
              prompt: validatedParams.prompt,
            }

            if (validatedParams.cwd !== undefined) {
              sessionRequest.cwd = validatedParams.cwd
            }
            if (validatedParams.extra_args !== undefined) {
              sessionRequest.extra_args = validatedParams.extra_args
            }

            await this.sessionManager.saveSession(sessionId, sessionRequest, {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              executionTime: result.executionTime,
            })

            this.logger.info('Session saved successfully', {
              requestId,
              sessionId: sessionId,
            })
          } catch (error) {
            // Log error but continue - session save failure should not break main flow
            this.logger.warn('Failed to save session', {
              requestId,
              sessionId: sessionId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        // Write output to file if output parameter is provided
        let outputFilePath: string | undefined
        if (validatedParams.output) {
          try {
            outputFilePath = path.isAbsolute(validatedParams.output)
              ? validatedParams.output
              : path.resolve(validatedParams.cwd, validatedParams.output)

            // Ensure directory exists
            const outputDir = path.dirname(outputFilePath)
            await fs.promises.mkdir(outputDir, { recursive: true })

            // Write result to file
            const outputContent = result.stdout || ''
            await fs.promises.writeFile(outputFilePath, outputContent, 'utf-8')

            this.logger.info('Output written to file', {
              requestId,
              outputPath: outputFilePath,
              contentLength: outputContent.length,
            })
          } catch (error) {
            this.logger.warn('Failed to write output file', {
              requestId,
              outputPath: validatedParams.output,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }

        // Mark MCP request as completed

        return this.formatExecutionResponse(
          result,
          validatedParams.agent,
          requestId,
          sessionId,
          outputFilePath,
          tokenWarning
        )
      }

      // Fallback response if executor is not available
      this.logger.warn('Agent executor not available', { requestId })
      return {
        content: [
          {
            type: 'text',
            text: `Agent execution request received for '${validatedParams.agent}' with prompt: "${validatedParams.prompt}"\n\nNote: Agent executor not initialized.`,
          },
        ],
      }
    } catch (error) {
      const totalTime = Date.now() - startTime

      this.logger.error('Agent execution failed', error instanceof Error ? error : undefined, {
        requestId,
        totalTime,
        errorType: error instanceof Error ? error.constructor.name : 'Unknown',
      })

      return this.createErrorResponse(
        `Agent execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        null
      )
    }
  }

  /**
   * Validate and type-check the input parameters with comprehensive validation
   *
   * @private
   * @param params - Raw parameters to validate
   * @returns Validated parameters
   * @throws {Error} When parameters are invalid
   */
  private validateParams(params: unknown): RunAgentParams {
    if (!params || typeof params !== 'object') {
      throw new Error('Invalid parameters: expected object')
    }

    const p = params as Record<string, unknown>

    // Validate required agent parameter with enhanced checks
    if (!p['agent'] || typeof p['agent'] !== 'string') {
      throw new Error('Agent parameter is required and must be a string')
    }

    const agentName = p['agent'].trim()
    if (agentName === '') {
      throw new Error('Invalid agent parameter: cannot be empty')
    }

    // Enhanced agent name validation
    if (agentName.length > 100) {
      throw new Error('Agent name too long (max 100 characters)')
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(agentName)) {
      throw new Error(
        'Agent name contains invalid characters (only alphanumeric, underscore, and dash allowed)'
      )
    }

    // Validate required prompt parameter with enhanced checks
    if (!p['prompt'] || typeof p['prompt'] !== 'string') {
      throw new Error('Prompt parameter is required and must be a string')
    }

    const prompt = p['prompt'].trim()
    if (prompt === '') {
      throw new Error('Invalid prompt parameter: cannot be empty')
    }

    if (prompt.length > 50000) {
      throw new Error('Prompt too long (max 50,000 characters)')
    }

    // Validate required cwd parameter with path validation
    if (p['cwd'] === undefined || p['cwd'] === null) {
      throw new Error('CWD parameter is required')
    }

    if (typeof p['cwd'] !== 'string') {
      throw new Error('CWD parameter must be a string')
    }

    const cwd = p['cwd'].trim()
    if (cwd === '') {
      throw new Error('CWD parameter cannot be empty')
    }

    if (cwd.length > 1000) {
      throw new Error('Working directory path too long (max 1000 characters)')
    }

    // Basic path security check - prevent obvious malicious paths
    if (cwd.includes('..') || cwd.includes('\0')) {
      throw new Error('Invalid working directory path')
    }

    // Validate optional extra_args parameter with enhanced checks
    if (p['extra_args'] !== undefined) {
      if (!Array.isArray(p['extra_args'])) {
        throw new Error('Extra args parameter must be an array if provided')
      }

      if (p['extra_args'].length > 20) {
        throw new Error('Too many extra arguments (max 20 allowed)')
      }

      for (const [index, arg] of p['extra_args'].entries()) {
        if (typeof arg !== 'string') {
          throw new Error(`Extra argument at index ${index} must be a string`)
        }

        if (arg.length > 1000) {
          throw new Error(`Extra argument at index ${index} too long (max 1000 characters)`)
        }
      }
    }

    // Validate optional session_id parameter
    if (p['session_id'] !== undefined) {
      if (typeof p['session_id'] !== 'string') {
        throw new Error('Session ID parameter must be a string if provided')
      }

      const sessionId = p['session_id'].trim()
      if (sessionId === '') {
        throw new Error('Invalid session ID parameter: cannot be empty')
      }

      if (sessionId.length > 100) {
        throw new Error('Session ID too long (max 100 characters)')
      }

      // Validate session ID format (alphanumeric, hyphens, underscores only)
      if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        throw new Error(
          'Session ID contains invalid characters (only alphanumeric, underscore, and dash allowed)'
        )
      }
    }

    // Validate optional output parameter
    if (p['output'] !== undefined) {
      if (typeof p['output'] !== 'string') {
        throw new Error('Output parameter must be a string if provided')
      }

      const outputPath = p['output'].trim()
      if (outputPath === '') {
        throw new Error('Invalid output parameter: cannot be empty')
      }

      if (outputPath.length > 1000) {
        throw new Error('Output path too long (max 1000 characters)')
      }

      // Basic path security check
      if (outputPath.includes('\0')) {
        throw new Error('Invalid output path: contains null bytes')
      }
    }

    // Validate optional model parameter
    if (p['model'] !== undefined) {
      if (typeof p['model'] !== 'string') {
        throw new Error('Model parameter must be a string if provided')
      }

      const model = p['model'].trim()
      if (model === '') {
        throw new Error('Invalid model parameter: cannot be empty')
      }

      // Validate model is a known model ID
      const validModels = ['claude-opus-4-5', 'claude-sonnet-4-5', 'gpt-5-2-codex']
      if (!validModels.includes(model)) {
        throw new Error(`Invalid model parameter: must be one of ${validModels.join(', ')}`)
      }
    }

    // Validate optional context_files parameter
    if (p['context_files'] !== undefined) {
      if (!Array.isArray(p['context_files'])) {
        throw new Error('Context files parameter must be an array if provided')
      }

      if (p['context_files'].length > 20) {
        throw new Error('Too many context files (max 20 allowed)')
      }

      for (const [index, file] of p['context_files'].entries()) {
        if (typeof file !== 'string') {
          throw new Error(`Context file at index ${index} must be a string`)
        }

        if (file.length > 1000) {
          throw new Error(`Context file path at index ${index} too long (max 1000 characters)`)
        }

        // Basic path security check
        if (file.includes('\0')) {
          throw new Error(`Context file path at index ${index} contains invalid characters`)
        }
      }
    }

    // Validate optional context_globs parameter
    if (p['context_globs'] !== undefined) {
      if (!Array.isArray(p['context_globs'])) {
        throw new Error('Context globs parameter must be an array if provided')
      }

      if (p['context_globs'].length > 10) {
        throw new Error('Too many context glob patterns (max 10 allowed)')
      }

      for (const [index, pattern] of p['context_globs'].entries()) {
        if (typeof pattern !== 'string') {
          throw new Error(`Context glob at index ${index} must be a string`)
        }

        if (pattern.length > 500) {
          throw new Error(`Context glob pattern at index ${index} too long (max 500 characters)`)
        }

        // Basic security check - no null bytes
        if (pattern.includes('\0')) {
          throw new Error(`Context glob pattern at index ${index} contains invalid characters`)
        }
      }
    }

    // Validate optional context_data parameter
    if (p['context_data'] !== undefined) {
      if (
        typeof p['context_data'] !== 'object' ||
        p['context_data'] === null ||
        Array.isArray(p['context_data'])
      ) {
        throw new Error('Context data parameter must be an object if provided')
      }

      // Check serialized size isn't too large
      const serialized = JSON.stringify(p['context_data'])
      if (serialized.length > 50000) {
        throw new Error('Context data too large (max 50KB when serialized)')
      }
    }

    return {
      agent: agentName,
      prompt: prompt,
      cwd: cwd,
      extra_args: p['extra_args'] as string[] | undefined,
      session_id: p['session_id'] as string | undefined,
      output: p['output'] as string | undefined,
      model: p['model'] as string | undefined,
      context_files: p['context_files'] as string[] | undefined,
      context_globs: p['context_globs'] as string[] | undefined,
      context_data: p['context_data'] as Record<string, unknown> | undefined,
    }
  }

  /**
   * Type guard to check if a value is a Record (plain object)
   *
   * @private
   * @param value - Value to check
   * @returns True if value is a Record
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /**
   * Type guard to check if a value is a string
   *
   * @private
   * @param value - Value to check
   * @returns True if value is a string
   */
  private isStringField(value: unknown): value is string {
    return typeof value === 'string'
  }

  /**
   * Extract content from agent response JSON
   *
   * Implements information extraction layer to hide agent implementation details.
   * Supports both cursor-agent and claude code response formats.
   *
   * @private
   * @param resultJson - Parsed agent response JSON (unknown type for safety)
   * @param isError - Whether this is an error response
   * @param stdout - Raw stdout as fallback
   * @param stderr - Raw stderr as fallback
   * @returns Extracted content string
   */
  private extractAgentContent(
    resultJson: unknown,
    isError: boolean,
    stdout: string,
    stderr: string
  ): string {
    // Type guard: Check if resultJson is a valid record
    if (!this.isRecord(resultJson)) {
      return stdout || stderr || 'No output'
    }

    // Priority field differs between success and error cases
    const primaryField = isError ? 'error' : 'result'

    // Extract primary field (result or error)
    if (this.isStringField(resultJson[primaryField])) {
      return resultJson[primaryField]
    }

    // Fallback to content field (claude code may use this)
    if (this.isStringField(resultJson['content'])) {
      return resultJson['content']
    }

    // Final fallback to raw stdout/stderr
    return stdout || stderr || 'No output'
  }

  /**
   * Determine if agent response indicates an error
   *
   * Checks is_error flag first (agent-level error), then exitCode (process-level error).
   *
   * @private
   * @param resultJson - Parsed agent response JSON
   * @param exitCode - Process exit code
   * @returns True if response indicates an error
   */
  private isAgentError(resultJson: unknown, exitCode: number): boolean {
    // Priority 1: Check agent's is_error flag
    if (this.isRecord(resultJson) && resultJson['is_error'] === true) {
      return true
    }

    // Priority 2: Check process exit code (excluding special cases)
    // 143: SIGTERM (normal termination)
    // 124: Timeout (may have partial result)
    return exitCode !== 0 && exitCode !== 143 && exitCode !== 124
  }

  /**
   * Format agent execution response (ADR-0003)
   *
   * Returns MCP 2025-06-18 compliant response with:
   * - content[0].text: JSON string (readable by current clients)
   * - structuredContent: structured data (MCP 2025-06-18 standard)
   * - _meta.session_id: session tracking (ADR-0002)
   *
   * @private
   * @param result - Agent execution result
   * @param agentName - Name of the executed agent
   * @param requestId - Request tracking ID
   * @param sessionId - Session ID if session management is used
   * @param outputPath - Path where output was written (if output parameter was provided)
   * @param tokenWarning - Optional warning about token budget
   * @returns Formatted MCP response
   */
  private formatExecutionResponse(
    result: AgentExecutionResult,
    agentName: string,
    requestId?: string,
    sessionId?: string,
    outputPath?: string,
    tokenWarning?: string
  ): McpToolResponse {
    // Determine if response indicates an error (agent-level or process-level)
    const isError = this.isAgentError(result.resultJson, result.exitCode)

    // Extract actual content from agent response
    const contentText = this.extractAgentContent(
      result.resultJson,
      isError,
      result.stdout,
      result.stderr
    )

    // Determine detailed status
    const isSuccess =
      result.exitCode === 0 || // Normal completion
      (result.exitCode === 143 && result.hasResult === true) // SIGTERM with result

    const isPartialSuccess = result.exitCode === 124 && result.hasResult === true // Timeout with partial result

    // Build response data structure (ADR-0003)
    // This object is used in both content[0].text and structuredContent
    const responseData: McpResponseData & { token_warning?: string } = {
      result: contentText,
      agent: agentName,
      exit_code: result.exitCode,
      execution_time: result.executionTime,
      status: isSuccess ? 'success' : isPartialSuccess ? 'partial' : 'error',
      ...(sessionId && { session_id: sessionId }),
      ...(requestId && { request_id: requestId }),
      ...(outputPath && { output_path: outputPath }),
      ...(tokenWarning && { token_warning: tokenWarning }),
    }

    const response: McpToolResponse = {
      content: [
        {
          type: 'text',
          // JSON string format for current MCP clients (Cursor, Claude Code, etc.)
          text: JSON.stringify(responseData, null, 2),
        },
      ],
      isError: isError,
      // Structured data format (MCP 2025-06-18 standard)
      structuredContent: responseData,
    }

    // Add session_id to response metadata (ADR-0002)
    if (sessionId) {
      response._meta = {
        session_id: sessionId,
      }
    }

    return response
  }

  /**
   * Create error response with optional available agents list (ADR-0003)
   *
   * @private
   * @param errorMessage - Error message to display
   * @param availableAgents - Optional list of available agents
   * @returns Error response in MCP format
   */
  private createErrorResponse(
    errorMessage: string,
    availableAgents: string[] | null
  ): McpToolResponse {
    // Build error response data
    const errorData: Record<string, unknown> = {
      status: 'error',
      error: errorMessage,
      ...(availableAgents && { available_agents: availableAgents }),
    }

    return {
      content: [
        {
          type: 'text',
          // JSON string format for current MCP clients
          text: JSON.stringify(errorData, null, 2),
        },
      ],
      isError: true,
      // Structured data format (MCP 2025-06-18 standard)
      structuredContent: errorData,
    }
  }

  /**
   * Generate unique request ID for tracking
   *
   * @private
   * @returns Unique request identifier
   */
  private generateRequestId(): string {
    return `run_agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Update execution statistics
   *
   * @private
   * @param agentName - Name of the executed agent
   * @param executionTime - Time taken for execution
   */
  private updateExecutionStats(agentName: string, executionTime: number): void {
    const existing = this.executionStats.get(agentName)

    if (existing) {
      existing.count += 1
      existing.totalTime += executionTime
      existing.lastUsed = new Date()
    } else {
      this.executionStats.set(agentName, {
        count: 1,
        totalTime: executionTime,
        lastUsed: new Date(),
      })
    }
  }

  /**
   * Get execution statistics for monitoring
   *
   * @returns Map of agent execution statistics
   */
  getExecutionStats(): Map<string, { count: number; totalTime: number; lastUsed: Date }> {
    return new Map(this.executionStats)
  }

  /**
   * Get list of available agent names
   *
   * @private
   * @returns Promise resolving to array of agent names
   */
  private async getAvailableAgentsList(): Promise<string[] | null> {
    if (!this.agentManager) {
      return null
    }

    try {
      const agents = await this.agentManager.listAgents()
      return agents.map((agent) => agent.name)
    } catch (error) {
      this.logger.warn('Failed to get available agents list', {
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      return null
    }
  }
}
