/**
 * Workflow state types for multi-agent orchestration.
 *
 * Tracks workflow progress, artifacts, and checkpoints for iterative
 * refinement loops with human approval gates.
 */

/**
 * Workflow phases corresponding to the multi-agent workflow structure.
 */
export type WorkflowPhase = 'planning' | 'implementation' | 'testing-setup' | 'testing-execution'

/**
 * Workflow status values indicating current state.
 */
export type WorkflowStatus =
  | 'idle'
  | 'working'
  | 'reviewing'
  | 'verifying'
  | 'checkpoint'
  | 'complete'
  | 'rejected'

/**
 * Artifact types produced during workflow execution.
 */
export type ArtifactType = 'plan' | 'review' | 'verification' | 'implementation' | 'test-result'

/**
 * Checkpoint decision options.
 */
export type CheckpointDecision = 'continue' | 'iterate' | 'approve' | 'reject'

/**
 * Record of feedback from a reviewer.
 */
export interface FeedbackRecord {
  /** Iteration number when feedback was given */
  iteration: number
  /** Name of the reviewer agent */
  reviewer: string
  /** Path to the feedback file */
  feedback_file: string
  /** Whether the feedback has been addressed */
  addressed: boolean
  /** Timestamp when feedback was created */
  created_at: string
}

/**
 * Record of an artifact produced during workflow.
 */
export interface ArtifactRecord {
  /** Iteration number when artifact was created */
  iteration: number
  /** Type of artifact */
  type: ArtifactType
  /** Path to the artifact file */
  file: string
  /** Agent that created this artifact */
  created_by: string
  /** Timestamp when artifact was created */
  created_at: string
}

/**
 * Record of a checkpoint decision.
 */
export interface CheckpointRecord {
  /** Iteration number when checkpoint was reached */
  iteration: number
  /** Decision made at checkpoint */
  decision: CheckpointDecision
  /** Optional feedback provided with decision */
  feedback?: string | undefined
  /** Timestamp when decision was made */
  decided_at: string
}

/**
 * Record of an agent execution within the workflow.
 */
export interface AgentRunRecord {
  /** Name of the agent */
  agent: string
  /** Iteration number */
  iteration: number
  /** Context files provided to the agent */
  context_files: string[]
  /** Output file path */
  output_file: string
  /** Timestamp when agent started */
  started_at: string
  /** Timestamp when agent completed */
  completed_at?: string
  /** Whether execution was successful */
  success?: boolean
  /** Error message if failed */
  error?: string
}

/**
 * Mapping of reviewers to their corresponding verifiers.
 */
export interface ReviewerVerifierMap {
  [reviewer: string]: string
}

/**
 * Default reviewer to verifier mapping for the workflow.
 */
export const DEFAULT_REVIEWER_VERIFIER_MAP: ReviewerVerifierMap = {
  // Planning phase
  'plan-reviewer-architecture': 'plan-verifier-architecture',
  'plan-reviewer-integration': 'plan-verifier-integration',
  'plan-reviewer-security': 'plan-verifier-security',
  // Implementation phase
  'code-reviewer-logic': 'code-verifier-logic',
  'code-reviewer-patterns': 'code-verifier-patterns',
  'code-reviewer-operations': 'code-verifier-operations',
  // Testing phase
  'test-reviewer-coverage': 'test-verifier-coverage',
  'test-reviewer-quality': 'test-verifier-quality',
  'test-reviewer-reliability': 'test-verifier-reliability',
}

/**
 * Complete workflow state persisted to disk.
 */
export interface WorkflowState {
  /** Unique identifier for the workflow */
  workflow_id: string
  /** Current phase of the workflow */
  phase: WorkflowPhase
  /** Current iteration number within the phase */
  iteration: number
  /** Current status of the workflow */
  status: WorkflowStatus
  /** Timestamp when workflow was created */
  created_at: string
  /** Timestamp when workflow was last updated */
  updated_at: string

  /** History of feedback from reviewers */
  feedback_history: FeedbackRecord[]
  /** Artifacts produced during workflow */
  artifacts: ArtifactRecord[]
  /** Checkpoints passed during workflow */
  checkpoints_passed: CheckpointRecord[]
  /** Record of agent executions */
  agent_runs: AgentRunRecord[]

  /** Mapping of reviewers to verifiers */
  reviewer_verifier_map: ReviewerVerifierMap

  /** Current artifact being worked on (if any) */
  current_artifact?: string | undefined
  /** Message to display at checkpoint (if paused) */
  checkpoint_message?: string | undefined
}

/**
 * Create a new workflow state with default values.
 */
export function createWorkflowState(
  workflowId: string,
  phase: WorkflowPhase = 'planning'
): WorkflowState {
  const now = new Date().toISOString()
  return {
    workflow_id: workflowId,
    phase,
    iteration: 1,
    status: 'idle',
    created_at: now,
    updated_at: now,
    feedback_history: [],
    artifacts: [],
    checkpoints_passed: [],
    agent_runs: [],
    reviewer_verifier_map: { ...DEFAULT_REVIEWER_VERIFIER_MAP },
  }
}
