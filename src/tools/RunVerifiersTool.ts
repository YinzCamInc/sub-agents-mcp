/**
 * RunVerifiersTool - MCP tool for running verifiers with automatic reviewer context mapping.
 *
 * This tool:
 * 1. Takes reviewer feedback files as input
 * 2. Automatically maps reviewers to their corresponding verifiers
 * 3. Runs verifiers in parallel with the reviewer feedback as context
 * 4. Collects verification results
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutor } from 'src/execution/AgentExecutor'
import { type AgentModelId, MODEL_MAP } from 'src/types/AgentDefinition'
import { DEFAULT_REVIEWER_VERIFIER_MAP, type ReviewerVerifierMap } from 'src/types/WorkflowState'
import { Logger } from 'src/utils/Logger'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'

/**
 * Schema for run_verifiers tool input.
 */
export interface RunVerifiersInputSchema {
  [x: string]: unknown
  type: 'object'
  properties: {
    [x: string]: object
    review_files: {
      type: 'array'
      items: {
        type: 'object'
        properties: {
          reviewer: { type: 'string'; description: string }
          file: { type: 'string'; description: string }
        }
        required: string[]
      }
      description: string
    }
    artifact_file: {
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
    workflow_id: {
      type: 'string'
      description: string
    }
    output_dir: {
      type: 'string'
      description: string
    }
    custom_mapping: {
      type: 'object'
      description: string
    }
  }
  required: string[]
}

/**
 * Review file input.
 */
export interface ReviewFileInput {
  reviewer: string
  file: string
}

/**
 * Validated parameters for run_verifiers execution.
 */
export interface RunVerifiersParams {
  review_files: ReviewFileInput[]
  artifact_file: string
  prompt: string
  cwd: string
  workflow_id?: string | undefined
  output_dir?: string | undefined
  custom_mapping?: ReviewerVerifierMap | undefined
}

/**
 * Result of a single verifier execution.
 */
export interface VerifierResult {
  reviewer: string
  verifier: string
  success: boolean
  output: string
  output_path?: string
  issues_found: number
  critical_issues: number
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
 * Tool for running verifiers with automatic reviewer→verifier mapping.
 */
export class RunVerifiersTool {
  public readonly name = 'run_verifiers'
  public readonly description =
    'Runs verifier agents for reviewer feedback with automatic reviewer→verifier mapping. ' +
    'Each verifier receives the original artifact and its corresponding reviewer feedback.'

  public readonly inputSchema: RunVerifiersInputSchema = {
    type: 'object',
    properties: {
      review_files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            reviewer: { type: 'string', description: 'Name of the reviewer agent' },
            file: { type: 'string', description: 'Path to the review feedback file' },
          },
          required: ['reviewer', 'file'],
        },
        description: 'List of reviewer feedback files to verify',
      },
      artifact_file: {
        type: 'string',
        description: 'Path to the artifact being reviewed (e.g., the plan or code)',
      },
      prompt: {
        type: 'string',
        description: 'Additional instructions for the verifiers',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for execution',
      },
      workflow_id: {
        type: 'string',
        description: 'Optional workflow ID for state tracking',
      },
      output_dir: {
        type: 'string',
        description: 'Directory to save verification outputs',
      },
      custom_mapping: {
        type: 'object',
        description: 'Optional custom reviewer→verifier mapping',
      },
    },
    required: ['review_files', 'artifact_file', 'prompt', 'cwd'],
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
  private validateParams(params: unknown): RunVerifiersParams {
    if (typeof params !== 'object' || params === null) {
      throw new Error('Parameters must be an object')
    }

    const p = params as Record<string, unknown>

    // Validate required review_files array
    if (!Array.isArray(p['review_files'])) {
      throw new Error('Review files parameter must be an array')
    }
    if (p['review_files'].length === 0) {
      throw new Error('At least one review file is required')
    }
    for (const [index, rf] of p['review_files'].entries()) {
      if (typeof rf !== 'object' || rf === null) {
        throw new Error(`Review file at index ${index} must be an object`)
      }
      const reviewFile = rf as Record<string, unknown>
      if (typeof reviewFile['reviewer'] !== 'string') {
        throw new Error(`Review file at index ${index} must have a 'reviewer' string`)
      }
      if (typeof reviewFile['file'] !== 'string') {
        throw new Error(`Review file at index ${index} must have a 'file' string`)
      }
    }

    // Validate required artifact_file
    if (typeof p['artifact_file'] !== 'string') {
      throw new Error('Artifact file parameter must be a string')
    }

    // Validate required prompt
    if (typeof p['prompt'] !== 'string') {
      throw new Error('Prompt parameter must be a string')
    }

    // Validate required cwd
    if (typeof p['cwd'] !== 'string') {
      throw new Error('Cwd parameter must be a string')
    }

    // Validate optional workflow_id
    if (p['workflow_id'] !== undefined && typeof p['workflow_id'] !== 'string') {
      throw new Error('Workflow ID must be a string if provided')
    }

    // Validate optional output_dir
    if (p['output_dir'] !== undefined && typeof p['output_dir'] !== 'string') {
      throw new Error('Output directory must be a string if provided')
    }

    // Validate optional custom_mapping
    if (p['custom_mapping'] !== undefined) {
      if (typeof p['custom_mapping'] !== 'object' || p['custom_mapping'] === null) {
        throw new Error('Custom mapping must be an object if provided')
      }
    }

    return {
      review_files: p['review_files'] as ReviewFileInput[],
      artifact_file: p['artifact_file'] as string,
      prompt: p['prompt'] as string,
      cwd: p['cwd'] as string,
      workflow_id: p['workflow_id'] as string | undefined,
      output_dir: p['output_dir'] as string | undefined,
      custom_mapping: p['custom_mapping'] as ReviewerVerifierMap | undefined,
    }
  }

  /**
   * Get the verifier for a reviewer.
   */
  private getVerifierForReviewer(
    reviewer: string,
    customMapping?: ReviewerVerifierMap
  ): string | undefined {
    // Check custom mapping first
    if (customMapping?.[reviewer]) {
      return customMapping[reviewer]
    }
    // Fall back to default mapping
    return DEFAULT_REVIEWER_VERIFIER_MAP[reviewer]
  }

  /**
   * Parse verification output to count issues.
   */
  private parseVerificationOutput(output: string): { issues: number; critical: number } {
    // Simple heuristic: count lines starting with certain markers
    const lines = output.split('\n')
    let issues = 0
    let critical = 0

    for (const line of lines) {
      const lowerLine = line.toLowerCase()
      if (
        lowerLine.includes('issue:') ||
        lowerLine.includes('- [ ]') ||
        lowerLine.includes('problem:') ||
        lowerLine.includes('concern:')
      ) {
        issues++
      }
      if (
        lowerLine.includes('critical:') ||
        lowerLine.includes('severe:') ||
        lowerLine.includes('blocker:')
      ) {
        critical++
      }
    }

    return { issues, critical }
  }

  /**
   * Execute a single verifier.
   */
  private async executeVerifier(
    reviewerName: string,
    verifierName: string,
    reviewContent: string,
    artifactContent: string,
    prompt: string,
    cwd: string,
    outputPath: string
  ): Promise<VerifierResult> {
    const startTime = Date.now()

    try {
      // Get verifier definition
      const verifierDef = await this.agentManager.getAgent(verifierName)
      if (!verifierDef) {
        throw new Error(`Verifier '${verifierName}' not found`)
      }

      // Build the full prompt with artifact and review context
      const fullPrompt = `# Context

## Original Artifact
\`\`\`
${artifactContent}
\`\`\`

## Reviewer Feedback (from ${reviewerName})
\`\`\`
${reviewContent}
\`\`\`

---

# Instructions

${prompt}

Please verify the reviewer's feedback. Check:
1. Are the issues identified valid?
2. Are there any false positives?
3. Are there any missed issues?
4. What is the overall assessment?`

      // Determine model to use
      const modelId = verifierDef.model
      const model = MODEL_MAP[modelId as AgentModelId]

      // Execute the verifier
      const result = await this.agentExecutor.executeAgent({
        agent: verifierDef.content,
        prompt: fullPrompt,
        cwd,
        model,
      })

      // Save output to file
      const outputDir = path.dirname(outputPath)
      await fs.promises.mkdir(outputDir, { recursive: true })
      await fs.promises.writeFile(outputPath, result.stdout, 'utf-8')

      // Parse output for issue counts
      const { issues, critical } = this.parseVerificationOutput(result.stdout)

      return {
        reviewer: reviewerName,
        verifier: verifierName,
        success: true,
        output: result.stdout,
        output_path: outputPath,
        issues_found: issues,
        critical_issues: critical,
        duration_ms: Date.now() - startTime,
      }
    } catch (error) {
      return {
        reviewer: reviewerName,
        verifier: verifierName,
        success: false,
        output: '',
        issues_found: 0,
        critical_issues: 0,
        error: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - startTime,
      }
    }
  }

  /**
   * Execute the run_verifiers tool.
   */
  async execute(params: unknown): Promise<McpToolResponse> {
    const requestId = `run_verifiers_${Date.now()}`
    this.logger.info('Executing run_verifiers', { requestId })

    try {
      // Validate parameters
      const validatedParams = this.validateParams(params)

      // Read the artifact file
      const artifactPath = path.isAbsolute(validatedParams.artifact_file)
        ? validatedParams.artifact_file
        : path.resolve(validatedParams.cwd, validatedParams.artifact_file)
      const artifactContent = await fs.promises.readFile(artifactPath, 'utf-8')

      // Determine output directory
      const outputDir = validatedParams.output_dir
        ? path.isAbsolute(validatedParams.output_dir)
          ? validatedParams.output_dir
          : path.resolve(validatedParams.cwd, validatedParams.output_dir)
        : path.resolve(validatedParams.cwd, '.cursor', 'agents', 'verifications')

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

      // Create execution promises for each reviewer's verifier
      const executionPromises: Promise<VerifierResult>[] = []
      const skippedReviewers: string[] = []

      for (const reviewFile of validatedParams.review_files) {
        const verifierName = this.getVerifierForReviewer(
          reviewFile.reviewer,
          validatedParams.custom_mapping
        )

        if (!verifierName) {
          this.logger.warn('No verifier mapping for reviewer', { reviewer: reviewFile.reviewer })
          skippedReviewers.push(reviewFile.reviewer)
          continue
        }

        // Read the review file
        const reviewPath = path.isAbsolute(reviewFile.file)
          ? reviewFile.file
          : path.resolve(validatedParams.cwd, reviewFile.file)

        let reviewContent: string
        try {
          reviewContent = await fs.promises.readFile(reviewPath, 'utf-8')
        } catch (error) {
          this.logger.error('Failed to read review file', undefined, {
            filePath: reviewFile.file,
            errorMsg: error instanceof Error ? error.message : String(error),
          })
          continue
        }

        const outputPath = path.join(outputDir, `${verifierName}-${timestamp}.md`)

        // Record run if workflow tracking is enabled
        if (validatedParams.workflow_id && this.workflowManager) {
          await this.workflowManager.recordAgentRun(
            validatedParams.workflow_id,
            verifierName,
            [reviewFile.file, validatedParams.artifact_file],
            outputPath
          )
        }

        executionPromises.push(
          this.executeVerifier(
            reviewFile.reviewer,
            verifierName,
            reviewContent,
            artifactContent,
            validatedParams.prompt,
            validatedParams.cwd,
            outputPath
          )
        )
      }

      // Execute all verifiers in parallel
      const results = await Promise.all(executionPromises)

      // Summarize results
      const successful = results.filter((r) => r.success)
      const failed = results.filter((r) => !r.success)
      const totalIssues = results.reduce((sum, r) => sum + r.issues_found, 0)
      const totalCritical = results.reduce((sum, r) => sum + r.critical_issues, 0)

      const summary = {
        total: results.length,
        successful: successful.length,
        failed: failed.length,
        skipped: skippedReviewers.length,
        total_issues: totalIssues,
        critical_issues: totalCritical,
      }

      this.logger.info('Run verifiers completed', { requestId, ...summary })

      // Build response text
      let responseText = '## Verification Results\n\n'
      responseText += `- **Total Verifiers**: ${summary.total}\n`
      responseText += `- **Successful**: ${summary.successful}\n`
      responseText += `- **Failed**: ${summary.failed}\n`
      if (summary.skipped > 0) {
        responseText += `- **Skipped (no mapping)**: ${summary.skipped} (${skippedReviewers.join(', ')})\n`
      }
      responseText += `- **Total Issues Found**: ${summary.total_issues}\n`
      responseText += `- **Critical Issues**: ${summary.critical_issues}\n\n`

      responseText += '### Verifier Details\n\n'
      for (const result of results) {
        if (result.success) {
          const criticalBadge = result.critical_issues > 0 ? ' ⚠️ CRITICAL' : ''
          responseText += `✅ **${result.verifier}** (verifying ${result.reviewer}) (${result.duration_ms}ms)${criticalBadge}\n`
          responseText += `   Issues: ${result.issues_found} | Critical: ${result.critical_issues}\n`
          responseText += `   Output: \`${result.output_path}\`\n\n`
        } else {
          responseText += `❌ **${result.verifier}** (verifying ${result.reviewer}) (${result.duration_ms}ms)\n`
          responseText += `   Error: ${result.error}\n\n`
        }
      }

      // Add recommendation based on results
      responseText += '### Recommendation\n\n'
      if (totalCritical > 0) {
        responseText += `⚠️ **${totalCritical} critical issue(s) found.** Review required before proceeding.\n`
      } else if (totalIssues > 0) {
        responseText += `ℹ️ **${totalIssues} issue(s) found.** Consider addressing before proceeding.\n`
      } else if (failed.length > 0) {
        responseText += '⚠️ Some verifiers failed to execute. Review errors before proceeding.\n'
      } else {
        responseText += '✅ All verifications passed. Safe to proceed.\n'
      }

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
        isError: failed.length > 0 || totalCritical > 0,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error('Run verifiers failed', undefined, { requestId, error: errorMessage })

      return {
        content: [
          {
            type: 'text',
            text: `Error executing verifiers: ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }
}
