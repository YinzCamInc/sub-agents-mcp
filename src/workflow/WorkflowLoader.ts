/**
 * WorkflowLoader - Loads and validates workflow definitions from YAML files.
 *
 * Handles:
 * - YAML parsing with js-yaml
 * - Schema validation
 * - Variable interpolation
 * - Default value injection
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type {
  InterpolationContext,
  IterativePhaseDefinition,
  PhaseDefinition,
  PhaseOutputs,
  TestExecutionPhaseDefinition,
  WorkflowDefinition,
  WorkflowLoadResult,
  WorkflowVariables,
} from 'src/types/WorkflowDefinition'
import { DEFAULT_WORKFLOW_VARIABLES } from 'src/types/WorkflowDefinition'
import type { WorkflowPhase } from 'src/types/WorkflowState'
import { Logger } from 'src/utils/Logger'

/**
 * Loader for workflow definition files.
 */
export class WorkflowLoader {
  private readonly logger: Logger
  private readonly workflowDir: string

  constructor(workflowDir?: string) {
    this.logger = new Logger('debug')
    this.workflowDir = workflowDir ?? path.join(process.cwd(), '.cursor', 'agents', 'workflows')
  }

  /**
   * Load a workflow definition from a YAML file.
   */
  async loadFromFile(filePath: string): Promise<WorkflowLoadResult> {
    this.logger.info('Loading workflow definition', { filePath })

    try {
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(this.workflowDir, filePath)

      const content = await fs.promises.readFile(resolvedPath, 'utf-8')
      const parsed = yaml.load(content) as Record<string, unknown>

      if (!parsed || typeof parsed !== 'object') {
        return {
          success: false,
          error: 'Invalid YAML: Expected an object',
          source_path: resolvedPath,
        }
      }

      const validationResult = this.validateDefinition(parsed)
      if (!validationResult.valid) {
        return {
          success: false,
          error: validationResult.error,
          source_path: resolvedPath,
        }
      }

      const definition = this.normalizeDefinition(parsed)

      this.logger.info('Workflow definition loaded', {
        name: definition.name,
        phases: definition.phases.length,
      })

      return {
        success: true,
        definition,
        source_path: resolvedPath,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error('Failed to load workflow definition', undefined, { error: errorMessage })

      return {
        success: false,
        error: `Failed to load workflow: ${errorMessage}`,
        source_path: filePath,
      }
    }
  }

  /**
   * Load a workflow definition from a YAML string.
   */
  loadFromString(yamlContent: string): WorkflowLoadResult {
    try {
      const parsed = yaml.load(yamlContent) as Record<string, unknown>

      if (!parsed || typeof parsed !== 'object') {
        return {
          success: false,
          error: 'Invalid YAML: Expected an object',
        }
      }

      const validationResult = this.validateDefinition(parsed)
      if (!validationResult.valid) {
        return {
          success: false,
          error: validationResult.error,
        }
      }

      const definition = this.normalizeDefinition(parsed)

      return {
        success: true,
        definition,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: `Failed to parse YAML: ${errorMessage}`,
      }
    }
  }

  /**
   * Validate a parsed workflow definition.
   */
  private validateDefinition(parsed: Record<string, unknown>): { valid: boolean; error?: string } {
    // Required fields
    if (!parsed['name'] || typeof parsed['name'] !== 'string') {
      return { valid: false, error: 'Workflow must have a "name" string field' }
    }

    if (!parsed['version'] || typeof parsed['version'] !== 'number') {
      return { valid: false, error: 'Workflow must have a "version" number field' }
    }

    if (!Array.isArray(parsed['phases']) || parsed['phases'].length === 0) {
      return { valid: false, error: 'Workflow must have at least one phase' }
    }

    // Validate each phase
    for (const [index, phase] of (parsed['phases'] as unknown[]).entries()) {
      const phaseValidation = this.validatePhase(phase, index)
      if (!phaseValidation.valid) {
        return phaseValidation
      }
    }

    return { valid: true }
  }

  /**
   * Validate a single phase definition.
   */
  private validatePhase(phase: unknown, index: number): { valid: boolean; error?: string } {
    if (!phase || typeof phase !== 'object') {
      return { valid: false, error: `Phase ${index} must be an object` }
    }

    const p = phase as Record<string, unknown>

    if (!p['id'] || typeof p['id'] !== 'string') {
      return { valid: false, error: `Phase ${index} must have an "id" string field` }
    }

    if (!p['type'] || typeof p['type'] !== 'string') {
      return { valid: false, error: `Phase ${index} must have a "type" string field` }
    }

    const validTypes = ['iterative', 'test-execution']
    if (!validTypes.includes(p['type'] as string)) {
      return {
        valid: false,
        error: `Phase ${index} has invalid type "${p['type']}". Must be one of: ${validTypes.join(', ')}`,
      }
    }

    if (p['type'] === 'iterative') {
      return this.validateIterativePhase(p, index)
    }

    if (p['type'] === 'test-execution') {
      return this.validateTestExecutionPhase(p, index)
    }

    return { valid: true }
  }

  /**
   * Validate an iterative phase.
   */
  private validateIterativePhase(
    phase: Record<string, unknown>,
    index: number
  ): { valid: boolean; error?: string } {
    if (!phase['creator'] || typeof phase['creator'] !== 'string') {
      return { valid: false, error: `Iterative phase ${index} must have a "creator" agent` }
    }

    if (!Array.isArray(phase['reviewers']) || phase['reviewers'].length === 0) {
      return { valid: false, error: `Iterative phase ${index} must have at least one reviewer` }
    }

    if (!Array.isArray(phase['verifiers']) || phase['verifiers'].length === 0) {
      return { valid: false, error: `Iterative phase ${index} must have at least one verifier` }
    }

    if (phase['reviewers'].length !== phase['verifiers'].length) {
      return {
        valid: false,
        error: `Iterative phase ${index} must have equal numbers of reviewers and verifiers`,
      }
    }

    return { valid: true }
  }

  /**
   * Validate a test execution phase.
   */
  private validateTestExecutionPhase(
    phase: Record<string, unknown>,
    index: number
  ): { valid: boolean; error?: string } {
    if (!phase['tester'] || typeof phase['tester'] !== 'string') {
      return { valid: false, error: `Test execution phase ${index} must have a "tester" agent` }
    }

    if (!phase['fixer'] || typeof phase['fixer'] !== 'string') {
      return { valid: false, error: `Test execution phase ${index} must have a "fixer" agent` }
    }

    return { valid: true }
  }

  /**
   * Normalize a parsed definition with defaults.
   */
  private normalizeDefinition(parsed: Record<string, unknown>): WorkflowDefinition {
    const variables: WorkflowVariables = {
      ...DEFAULT_WORKFLOW_VARIABLES,
      ...(parsed['variables'] as WorkflowVariables | undefined),
    }

    const phases = (parsed['phases'] as Record<string, unknown>[]).map((p) =>
      this.normalizePhase(p)
    )

    return {
      name: parsed['name'] as string,
      version: parsed['version'] as number,
      description: parsed['description'] as string | undefined,
      variables,
      phases,
      output_dir: (parsed['output_dir'] as string) ?? '.cursor/agents/workflow',
      input_file: parsed['input_file'] as string | undefined,
    }
  }

  /**
   * Normalize a single phase with defaults.
   */
  private normalizePhase(phase: Record<string, unknown>): PhaseDefinition {
    const basePhase = {
      id: phase['id'] as WorkflowPhase,
      type: phase['type'] as 'iterative' | 'test-execution',
      context: phase['context'] as string[] | undefined,
      outputs: phase['outputs'] as PhaseOutputs | undefined,
      min_iterations: (phase['min_iterations'] as number) ?? 1,
      max_iterations: phase['max_iterations'] as number | undefined,
    }

    if (phase['type'] === 'iterative') {
      return {
        ...basePhase,
        type: 'iterative',
        creator: phase['creator'] as string,
        reviewers: phase['reviewers'] as string[],
        verifiers: phase['verifiers'] as string[],
        checkpoint_message: phase['checkpoint_message'] as string | undefined,
      } as IterativePhaseDefinition
    }

    return {
      ...basePhase,
      type: 'test-execution',
      tester: phase['tester'] as string,
      fixer: phase['fixer'] as string,
    } as TestExecutionPhaseDefinition
  }

  /**
   * Interpolate variables in a string.
   * Supports {{ variable }} syntax.
   */
  interpolate(template: string, context: InterpolationContext): string {
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (match, path) => {
      const trimmedPath = path.trim()

      // Check direct variables first
      if (context.variables[trimmedPath] !== undefined) {
        return String(context.variables[trimmedPath])
      }

      // Check special variables
      if (trimmedPath === 'iteration') {
        return String(context.iteration)
      }
      if (trimmedPath === 'phase') {
        return context.phase
      }

      // Check phase references (e.g., phases.planning.outputs.plan)
      if (trimmedPath.startsWith('phases.') && context.phases) {
        const parts = trimmedPath.split('.')
        if (parts.length >= 3) {
          const phaseId = parts[1]
          const phaseData = context.phases[phaseId]
          if (phaseData) {
            if (parts[2] === 'outputs' && phaseData.outputs && parts[3]) {
              const outputValue = phaseData.outputs[parts[3]]
              if (outputValue !== undefined) {
                return outputValue
              }
            }
          }
        }
      }

      // Return original if not found
      this.logger.warn('Variable not found in interpolation context', { variable: trimmedPath })
      return match
    })
  }

  /**
   * Interpolate all strings in a phase outputs configuration.
   */
  interpolateOutputs(
    outputs: PhaseOutputs | undefined,
    context: InterpolationContext
  ): PhaseOutputs | undefined {
    if (!outputs) return undefined

    const result: PhaseOutputs = {}
    for (const [key, value] of Object.entries(outputs)) {
      if (value !== undefined) {
        result[key] = this.interpolate(value, context)
      }
    }
    return result
  }

  /**
   * List available workflow definitions in the workflow directory.
   */
  async listWorkflows(): Promise<string[]> {
    try {
      await fs.promises.mkdir(this.workflowDir, { recursive: true })
      const files = await fs.promises.readdir(this.workflowDir)
      return files
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map((f) => f.replace(/\.(yaml|yml)$/, ''))
    } catch {
      return []
    }
  }

  /**
   * Create a default workflow definition file.
   */
  async createDefaultWorkflow(name: string): Promise<WorkflowLoadResult> {
    const definition: WorkflowDefinition = {
      name,
      version: 1,
      description: 'Default multi-agent workflow with planning, implementation, and testing phases',
      variables: {
        output_dir: '.cursor/agents/workflow',
      },
      phases: [
        {
          id: 'planning',
          type: 'iterative',
          creator: 'plan-creator',
          reviewers: [
            'plan-reviewer-architecture',
            'plan-reviewer-integration',
            'plan-reviewer-security',
          ],
          verifiers: [
            'plan-verifier-architecture',
            'plan-verifier-integration',
            'plan-verifier-security',
          ],
          outputs: {
            artifact: '{{ output_dir }}/plans/plan-v{{ iteration }}.md',
            reviews: '{{ output_dir }}/reviews/plan-v{{ iteration }}/',
            verifications: '{{ output_dir }}/verifications/plan-v{{ iteration }}/',
          },
          min_iterations: 2,
        },
        {
          id: 'implementation',
          type: 'iterative',
          creator: 'implementer',
          reviewers: ['code-reviewer-logic', 'code-reviewer-patterns', 'code-reviewer-operations'],
          verifiers: ['code-verifier-logic', 'code-verifier-patterns', 'code-verifier-operations'],
          context: ['{{ phases.planning.outputs.artifact }}'],
          outputs: {
            reviews: '{{ output_dir }}/reviews/impl-v{{ iteration }}/',
            verifications: '{{ output_dir }}/verifications/impl-v{{ iteration }}/',
          },
          min_iterations: 1,
        },
        {
          id: 'testing-setup',
          type: 'iterative',
          creator: 'test-writer',
          reviewers: [
            'test-reviewer-coverage',
            'test-reviewer-quality',
            'test-reviewer-reliability',
          ],
          verifiers: [
            'test-verifier-coverage',
            'test-verifier-quality',
            'test-verifier-reliability',
          ],
          context: ['{{ phases.planning.outputs.artifact }}'],
          outputs: {
            reviews: '{{ output_dir }}/reviews/test-v{{ iteration }}/',
            verifications: '{{ output_dir }}/verifications/test-v{{ iteration }}/',
          },
          min_iterations: 1,
        },
        {
          id: 'testing-execution',
          type: 'test-execution',
          tester: 'test-writer',
          fixer: 'implementer',
          outputs: {
            artifact: '{{ output_dir }}/test-results/run-{{ iteration }}.md',
          },
          min_iterations: 1,
        },
      ],
      output_dir: '.cursor/agents/workflow',
    }

    const yamlContent = yaml.dump(definition, { lineWidth: -1 })

    await fs.promises.mkdir(this.workflowDir, { recursive: true })
    const filePath = path.join(this.workflowDir, `${name}.yaml`)
    await fs.promises.writeFile(filePath, yamlContent, 'utf-8')

    this.logger.info('Created default workflow', { name, path: filePath })

    return {
      success: true,
      definition,
      source_path: filePath,
    }
  }
}
