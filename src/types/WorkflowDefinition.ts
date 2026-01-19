/**
 * WorkflowDefinition types for YAML-defined workflow configurations.
 *
 * Supports:
 * - Multiple phases (planning, implementation, testing-setup, testing-execution)
 * - Iterative refinement loops with reviewers/verifiers
 * - Variable interpolation with Mustache-like syntax
 * - Human checkpoints
 */

import type { WorkflowPhase } from './WorkflowState'

/**
 * Type of workflow phase execution.
 */
export type PhaseType = 'iterative' | 'test-execution'

/**
 * Variable definition for interpolation.
 */
export interface WorkflowVariables {
  [key: string]: string | number | boolean
}

/**
 * Output configuration for a phase.
 */
export interface PhaseOutputs {
  /** Path pattern for main artifact (e.g., plan, implementation) */
  artifact?: string | undefined
  /** Directory for reviews */
  reviews?: string | undefined
  /** Directory for verifications */
  verifications?: string | undefined
  /** Custom output paths */
  [key: string]: string | undefined
}

/**
 * Configuration for an iterative phase (planning, implementation, testing-setup).
 */
export interface IterativePhaseDefinition {
  /** Unique identifier for this phase */
  id: WorkflowPhase
  /** Type of phase */
  type: 'iterative'
  /** Creator agent (planner, implementer, test-writer) */
  creator: string
  /** Reviewer agents (run in parallel) */
  reviewers: string[]
  /** Verifier agents (run in parallel, mapped to reviewers) */
  verifiers: string[]
  /** Output path configurations */
  outputs?: PhaseOutputs | undefined
  /** Context files/patterns from previous phases */
  context?: string[] | undefined
  /** Minimum number of iterations before approval allowed */
  min_iterations?: number | undefined
  /** Maximum iterations before forced completion */
  max_iterations?: number | undefined
  /** Custom checkpoint message */
  checkpoint_message?: string | undefined
}

/**
 * Configuration for test execution phase.
 */
export interface TestExecutionPhaseDefinition {
  /** Unique identifier for this phase */
  id: 'testing-execution'
  /** Type of phase */
  type: 'test-execution'
  /** Tester agent (runs tests, analyzes failures) */
  tester: string
  /** Fixer agent (implements fixes - typically the developer, NOT the tester) */
  fixer: string
  /** Context files/patterns */
  context?: string[] | undefined
  /** Output path configurations */
  outputs?: PhaseOutputs | undefined
  /** Minimum iterations */
  min_iterations?: number | undefined
  /** Maximum iterations */
  max_iterations?: number | undefined
}

/**
 * Union type for phase definitions.
 */
export type PhaseDefinition = IterativePhaseDefinition | TestExecutionPhaseDefinition

/**
 * Complete workflow definition loaded from YAML.
 */
export interface WorkflowDefinition {
  /** Name of the workflow */
  name: string
  /** Version of the workflow definition format */
  version: number
  /** Description of what this workflow does */
  description?: string | undefined
  /** Variables for interpolation */
  variables?: WorkflowVariables | undefined
  /** Ordered list of phases */
  phases: PhaseDefinition[]
  /** Default output directory */
  output_dir?: string | undefined
  /** Path to requirements or initial input file */
  input_file?: string | undefined
}

/**
 * Result of loading a workflow definition.
 */
export interface WorkflowLoadResult {
  /** Whether the load was successful */
  success: boolean
  /** The loaded workflow definition (if successful) */
  definition?: WorkflowDefinition | undefined
  /** Error message (if failed) */
  error?: string | undefined
  /** Path the workflow was loaded from */
  source_path?: string | undefined
}

/**
 * Context for variable interpolation.
 */
export interface InterpolationContext {
  /** Workflow variables */
  variables: WorkflowVariables
  /** Current iteration number */
  iteration: number
  /** Current phase */
  phase: WorkflowPhase
  /** Phase-specific outputs for reference */
  phases?: {
    [phaseId: string]: {
      outputs?: PhaseOutputs
    }
  }
}

/**
 * Default workflow variables.
 */
export const DEFAULT_WORKFLOW_VARIABLES: WorkflowVariables = {
  output_dir: '.cursor/agents/workflow',
  iteration: 1,
}

/**
 * Default phase configurations for the standard workflow.
 */
export const DEFAULT_PHASES: PhaseDefinition[] = [
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
    min_iterations: 2,
  },
  {
    id: 'implementation',
    type: 'iterative',
    creator: 'implementer',
    reviewers: ['code-reviewer-logic', 'code-reviewer-patterns', 'code-reviewer-operations'],
    verifiers: ['code-verifier-logic', 'code-verifier-patterns', 'code-verifier-operations'],
    min_iterations: 1,
  },
  {
    id: 'testing-setup',
    type: 'iterative',
    creator: 'test-writer',
    reviewers: ['test-reviewer-coverage', 'test-reviewer-quality', 'test-reviewer-reliability'],
    verifiers: ['test-verifier-coverage', 'test-verifier-quality', 'test-verifier-reliability'],
    min_iterations: 1,
  },
  {
    id: 'testing-execution',
    type: 'test-execution',
    tester: 'test-writer',
    fixer: 'implementer',
    min_iterations: 1,
  },
]

/**
 * Type guard to check if a phase is iterative.
 */
export function isIterativePhase(phase: PhaseDefinition): phase is IterativePhaseDefinition {
  return phase.type === 'iterative'
}

/**
 * Type guard to check if a phase is test execution.
 */
export function isTestExecutionPhase(
  phase: PhaseDefinition
): phase is TestExecutionPhaseDefinition {
  return phase.type === 'test-execution'
}
