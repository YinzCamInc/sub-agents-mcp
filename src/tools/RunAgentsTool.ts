/**
 * RunAgentsTool - MCP tool for parallel execution of multiple agents.
 *
 * Executes multiple agents in parallel with shared context and
 * collects their outputs for workflow orchestration.
 */

/**
 * Token budget constants for context size warnings.
 */
const TOKEN_BUDGET = {
  WARNING_CHARS: 100_000,
  LIMIT_CHARS: 400_000,
  CHARS_PER_TOKEN: 4,
} as const

import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'
import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutor } from 'src/execution/AgentExecutor'
import { type AgentModelId, MODEL_MAP } from 'src/types/AgentDefinition'
import { Logger } from 'src/utils/Logger'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'

/**
 * Schema for run_agents tool input.
 */
export interface RunAgentsInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    agents: {
      type: 'array'
      items: { type: 'string' }
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
    workflow_id: {
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
    output_dir: {
      type: 'string'
      description: string
    }
    fail_fast: {
      type: 'boolean'
      description: string
    }
  }
  required: string[]
}

/**
 * Validated parameters for run_agents execution.
 */
export interface RunAgentsParams {
  agents: string[]
  prompt: string
  cwd: string
  workflow_id?: string | undefined
  context_files?: string[] | undefined
  context_globs?: string[] | undefined
  context_data?: Record<string, unknown> | undefined
  output_dir?: string | undefined
  fail_fast?: boolean | undefined
}

/**
 * Result of a single agent execution.
 */
export interface AgentResult {
  agent: string
  success: boolean
  output: string
  output_path?: string
  error?: string
  duration_ms: number
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
 * Tool for parallel execution of multiple AI agents.
 */
export class RunAgentsTool {
  public readonly name = 'run_agents'
  public readonly description =
    'Executes multiple AI agents in parallel with shared context. ' +
    'Useful for running multiple reviewers or verifiers simultaneously.'

  public readonly inputSchema: RunAgentsInputSchema = {
    type: 'object',
    properties: {
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of agent names to execute in parallel',
      },
      prompt: {
        type: 'string',
        description: 'The prompt/instructions for all agents',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for agent execution',
      },
      workflow_id: {
        type: 'string',
        description: 'Optional workflow ID for state tracking',
      },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of file paths to include as context',
      },
      context_globs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns to match files for context',
      },
      context_data: {
        type: 'object',
        description: 'Structured data to include in context',
      },
      output_dir: {
        type: 'string',
        description: 'Directory to save agent outputs (default: .cursor/agents/outputs)',
      },
      fail_fast: {
        type: 'boolean',
        description: 'If true, stop all agents if one fails (default: false)',
      },
    },
    required: ['agents', 'prompt', 'cwd'],
  }

  private readonly logger: Logger

  constructor(
    private readonly agentExecutor: AgentExecutor,
    private readonly agentManager: AgentManager,
    private readonly workflowManager?: WorkflowManager
  ) {
    this.logger = new Logger('debug')
  }

  /**
   * Validate and cast input parameters.
   */
  private validateParams(params: unknown): RunAgentsParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('Parameters must be an object')
    }

    const p = params as Record<string, unknown>

    // Validate required agents array
    if (!Array.isArray(p['agents'])) {
      throw new Error('Agents parameter must be an array')
    }
    if (p['agents'].length === 0) {
      throw new Error('At least one agent is required')
    }
    if (p['agents'].length > 10) {
      throw new Error('Too many agents (max 10 allowed for parallel execution)')
    }
    for (const [index, agent] of p['agents'].entries()) {
      if (typeof agent !== 'string') {
        throw new Error(`Agent at index ${index} must be a string`)
      }
    }

    // Validate required prompt
    if (typeof p['prompt'] !== 'string') {
      throw new Error('Prompt parameter must be a string')
    }
    if (p['prompt'].length === 0) {
      throw new Error('Prompt cannot be empty')
    }

    // Validate required cwd
    if (typeof p['cwd'] !== 'string') {
      throw new Error('Cwd parameter must be a string')
    }

    // Validate optional workflow_id
    if (p['workflow_id'] !== undefined && typeof p['workflow_id'] !== 'string') {
      throw new Error('Workflow ID must be a string if provided')
    }

    // Validate optional context_files
    if (p['context_files'] !== undefined) {
      if (!Array.isArray(p['context_files'])) {
        throw new Error('Context files parameter must be an array if provided')
      }
      for (const [index, file] of p['context_files'].entries()) {
        if (typeof file !== 'string') {
          throw new Error(`Context file at index ${index} must be a string`)
        }
      }
    }

    // Validate optional context_globs
    if (p['context_globs'] !== undefined) {
      if (!Array.isArray(p['context_globs'])) {
        throw new Error('Context globs parameter must be an array if provided')
      }
      for (const [index, pattern] of p['context_globs'].entries()) {
        if (typeof pattern !== 'string') {
          throw new Error(`Context glob pattern at index ${index} must be a string`)
        }
      }
    }

    // Validate optional context_data
    if (p['context_data'] !== undefined) {
      if (typeof p['context_data'] !== 'object' || p['context_data'] === null) {
        throw new Error('Context data must be an object if provided')
      }
    }

    // Validate optional output_dir
    if (p['output_dir'] !== undefined && typeof p['output_dir'] !== 'string') {
      throw new Error('Output directory must be a string if provided')
    }

    // Validate optional fail_fast
    if (p['fail_fast'] !== undefined && typeof p['fail_fast'] !== 'boolean') {
      throw new Error('Fail fast must be a boolean if provided')
    }

    return {
      agents: p['agents'] as string[],
      prompt: p['prompt'] as string,
      cwd: p['cwd'] as string,
      workflow_id: p['workflow_id'] as string | undefined,
      context_files: p['context_files'] as string[] | undefined,
      context_globs: p['context_globs'] as string[] | undefined,
      context_data: p['context_data'] as Record<string, unknown> | undefined,
      output_dir: p['output_dir'] as string | undefined,
      fail_fast: p['fail_fast'] as boolean | undefined,
    }
  }

  /**
   * Build context section from files, globs, and data.
   */
  private async buildContext(params: RunAgentsParams): Promise<string> {
    let contextSection = ''

    // Add files from context_files
    if (params.context_files && params.context_files.length > 0) {
      for (const filePath of params.context_files) {
        try {
          const resolvedPath = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(params.cwd, filePath)
          const content = await fs.promises.readFile(resolvedPath, 'utf-8')
          contextSection += `\n## File: ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`
        } catch (error) {
          this.logger.warn('Failed to read context file', {
            filePath,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    // Add files from context_globs
    if (params.context_globs && params.context_globs.length > 0) {
      for (const pattern of params.context_globs) {
        try {
          const files = await glob(pattern, { cwd: params.cwd })
          for (const filePath of files) {
            const resolvedPath = path.isAbsolute(filePath)
              ? filePath
              : path.resolve(params.cwd, filePath)
            const content = await fs.promises.readFile(resolvedPath, 'utf-8')
            contextSection += `\n## File: ${filePath}\n\`\`\`\n${content}\n\`\`\`\n`
          }
        } catch (error) {
          this.logger.warn('Failed to process context glob', {
            pattern,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    // Add structured context data
    if (params.context_data) {
      contextSection += `\n## Context Data\n\`\`\`json\n${JSON.stringify(params.context_data, null, 2)}\n\`\`\`\n`
    }

    return contextSection
  }

  /**
   * Execute a single agent.
   */
  private async executeAgent(
    agentName: string,
    fullPrompt: string,
    params: RunAgentsParams,
    outputPath: string
  ): Promise<AgentResult> {
    const startTime = Date.now()

    try {
      // Get agent definition for model info
      const agentDef = await this.agentManager.getAgent(agentName)
      if (!agentDef) {
        throw new Error(`Agent '${agentName}' not found`)
      }

      // Determine model to use
      const modelId = agentDef.model
      const model = MODEL_MAP[modelId as AgentModelId]

      // Execute the agent
      const result = await this.agentExecutor.executeAgent({
        agent: agentDef.content,
        prompt: fullPrompt,
        cwd: params.cwd,
        model,
      })

      // Save output to file
      const outputDir = path.dirname(outputPath)
      await fs.promises.mkdir(outputDir, { recursive: true })
      await fs.promises.writeFile(outputPath, result.stdout, 'utf-8')

      return {
        agent: agentName,
        success: true,
        output: result.stdout,
        output_path: outputPath,
        duration_ms: Date.now() - startTime,
      }
    } catch (error) {
      return {
        agent: agentName,
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startTime,
      }
    }
  }

  /**
   * Execute the run_agents tool.
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const requestId = `run_agents_${Date.now()}`
    this.logger.info('Executing run_agents', { requestId })

    try {
      // Validate parameters
      const validatedParams = this.validateParams(params)

      // Build context section
      const contextSection = await this.buildContext(validatedParams)
      const fullPrompt = contextSection
        ? `# Context\n${contextSection}\n---\n\n# Instructions\n\n${validatedParams.prompt}`
        : validatedParams.prompt

      // Check token budget
      let tokenWarning: string | undefined
      const estimatedTokens = Math.ceil(fullPrompt.length / TOKEN_BUDGET.CHARS_PER_TOKEN)
      if (fullPrompt.length > TOKEN_BUDGET.LIMIT_CHARS) {
        tokenWarning = `⚠️ CONTEXT SIZE WARNING: Shared context (${fullPrompt.length.toLocaleString()} chars, ~${estimatedTokens.toLocaleString()} tokens) exceeds recommended limit.`
        this.logger.warn('Context size exceeds limit', {
          requestId,
          contextSize: fullPrompt.length,
          estimatedTokens,
        })
      } else if (fullPrompt.length > TOKEN_BUDGET.WARNING_CHARS) {
        tokenWarning = `ℹ️ Large shared context (${fullPrompt.length.toLocaleString()} chars, ~${estimatedTokens.toLocaleString()} tokens).`
        this.logger.info('Context size approaching limit', {
          requestId,
          contextSize: fullPrompt.length,
        })
      }

      // Determine output directory
      const outputDir = validatedParams.output_dir
        ? path.isAbsolute(validatedParams.output_dir)
          ? validatedParams.output_dir
          : path.resolve(validatedParams.cwd, validatedParams.output_dir)
        : path.resolve(validatedParams.cwd, '.cursor', 'agents', 'outputs')

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

      // Create execution promises for all agents
      const executionPromises = validatedParams.agents.map(async (agentName) => {
        const outputPath = path.join(outputDir, `${agentName}-${timestamp}.md`)

        // Record run if workflow tracking is enabled
        let runIndex: number | undefined
        if (validatedParams.workflow_id && this.workflowManager) {
          const recordResult = await this.workflowManager.recordAgentRun(
            validatedParams.workflow_id,
            agentName,
            validatedParams.context_files || [],
            outputPath
          )
          runIndex = recordResult.runIndex
        }

        const result = await this.executeAgent(agentName, fullPrompt, validatedParams, outputPath)

        // Complete run if workflow tracking is enabled
        if (validatedParams.workflow_id && this.workflowManager && runIndex !== undefined) {
          await this.workflowManager.completeAgentRun(
            validatedParams.workflow_id,
            runIndex,
            result.success,
            result.error
          )
        }

        return result
      })

      // Execute in parallel or with fail-fast
      let results: AgentResult[]
      if (validatedParams.fail_fast) {
        // With fail-fast, we still run in parallel but reject on first failure
        results = await Promise.all(
          executionPromises.map((p) =>
            p.then((r) => {
              if (!r.success) {
                throw new Error(`Agent ${r.agent} failed: ${r.error}`)
              }
              return r
            })
          )
        ).catch(async (error: Error) => {
          // Wait for all to complete and return partial results
          const settled = await Promise.allSettled(executionPromises)
          return settled.map(
            (s, i): AgentResult =>
              s.status === 'fulfilled'
                ? s.value
                : {
                    agent: validatedParams.agents[i] ?? 'unknown',
                    success: false,
                    output: '',
                    error: error.message,
                    duration_ms: 0,
                  }
          )
        })
      } else {
        // Without fail-fast, collect all results
        results = await Promise.all(executionPromises)
      }

      // Summarize results
      const successful = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)

      const summary = {
        total: results.length,
        successful: successful.length,
        failed: failed.length,
        results: results.map((r) => ({
          agent: r.agent,
          success: r.success,
          output_path: r.output_path,
          error: r.error,
          duration_ms: r.duration_ms,
        })),
      }

      this.logger.info('Run agents completed', { requestId, ...summary })

      // Build response text
      let responseText = '## Parallel Agent Execution Results\n\n'
      if (tokenWarning) {
        responseText += `${tokenWarning}\n\n`
      }
      responseText += `- **Total**: ${summary.total}\n`
      responseText += `- **Successful**: ${summary.successful}\n`
      responseText += `- **Failed**: ${summary.failed}\n\n`

      responseText += '### Agent Results\n\n'
      for (const result of results) {
        if (result.success) {
          responseText += `✅ **${result.agent}** (${result.duration_ms}ms)\n`
          responseText += `   Output: \`${result.output_path}\`\n\n`
        } else {
          responseText += `❌ **${result.agent}** (${result.duration_ms}ms)\n`
          responseText += `   Error: ${result.error}\n\n`
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        isError: failed.length > 0,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error('Run agents failed', undefined, { requestId, error: errorMessage })

      return {
        content: [
          {
            type: 'text',
            text: `Error executing agents: ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }
}
