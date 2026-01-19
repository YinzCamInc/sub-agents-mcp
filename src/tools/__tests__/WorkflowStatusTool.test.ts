/**
 * Tests for WorkflowStatusTool
 *
 * Tests workflow status display with various states and verbosity levels.
 */

import type { WorkflowState } from 'src/types/WorkflowState'
import { createWorkflowState } from 'src/types/WorkflowState'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowStatusTool } from '../WorkflowStatusTool'

describe('WorkflowStatusTool', () => {
  let tool: WorkflowStatusTool
  let mockWorkflowManager: WorkflowManager
  let mockWorkflowState: WorkflowState

  beforeEach(() => {
    vi.clearAllMocks()

    mockWorkflowState = createWorkflowState('test-workflow', 'planning')
    mockWorkflowState.iteration = 2
    mockWorkflowState.status = 'working'

    mockWorkflowManager = {
      getWorkflow: vi.fn().mockResolvedValue(mockWorkflowState),
    } as unknown as WorkflowManager

    tool = new WorkflowStatusTool(mockWorkflowManager)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('workflow_status')
    })

    it('should have description', () => {
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain('status')
    })

    it('should have input schema with required fields', () => {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties.workflow_id).toBeDefined()
      expect(tool.inputSchema.required).toContain('workflow_id')
    })

    it('should have optional verbose parameter', () => {
      expect(tool.inputSchema.properties.verbose).toBeDefined()
      expect(tool.inputSchema.properties.verbose.type).toBe('boolean')
    })
  })

  describe('parameter validation', () => {
    it('should reject non-object params', async () => {
      const result = await tool.execute('not-an-object')
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('object')
    })

    it('should reject missing workflow_id', async () => {
      const result = await tool.execute({})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject non-string workflow_id', async () => {
      const result = await tool.execute({
        workflow_id: 123,
      })
      expect(result.isError).toBe(true)
    })

    it('should reject non-boolean verbose', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        verbose: 'yes',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('boolean')
    })
  })

  describe('workflow not found', () => {
    it('should return error if workflow does not exist', async () => {
      vi.mocked(mockWorkflowManager.getWorkflow).mockResolvedValue(undefined)

      const result = await tool.execute({
        workflow_id: 'nonexistent',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not found')
    })
  })

  describe('basic status display', () => {
    it('should display workflow ID', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('test-workflow')
    })

    it('should display current phase', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('planning')
    })

    it('should display current iteration', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('2')
    })

    it('should display current status', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('working')
    })

    it('should display timestamps', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('Created')
      expect(result.content[0].text).toContain('Updated')
    })
  })

  describe('status emojis', () => {
    const statusTests = [
      { status: 'idle', emoji: '⏸️' },
      { status: 'working', emoji: '🔄' },
      { status: 'reviewing', emoji: '👀' },
      { status: 'verifying', emoji: '✅' },
      { status: 'checkpoint', emoji: '🚧' },
      { status: 'complete', emoji: '✨' },
      { status: 'rejected', emoji: '❌' },
    ] as const

    for (const { status, emoji } of statusTests) {
      it(`should show ${emoji} for ${status} status`, async () => {
        mockWorkflowState.status = status

        const result = await tool.execute({
          workflow_id: 'test-workflow',
        })

        expect(result.content[0].text).toContain(emoji)
      })
    }
  })

  describe('checkpoint display', () => {
    it('should display checkpoint message when at checkpoint', async () => {
      mockWorkflowState.status = 'checkpoint'
      mockWorkflowState.checkpoint_message = 'Review the plan before proceeding'

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('Checkpoint')
      expect(result.content[0].text).toContain('Review the plan before proceeding')
    })

    it('should show available actions at checkpoint', async () => {
      mockWorkflowState.status = 'checkpoint'
      mockWorkflowState.checkpoint_message = 'Review required'

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('continue_workflow')
      expect(result.content[0].text).toContain('reject_workflow')
    })
  })

  describe('current artifact display', () => {
    it('should display current artifact if present', async () => {
      mockWorkflowState.current_artifact = 'plans/plan-v2.md'

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('Current Artifact')
      expect(result.content[0].text).toContain('plans/plan-v2.md')
    })

    it('should not show current artifact section if not set', async () => {
      mockWorkflowState.current_artifact = undefined

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).not.toContain('Current Artifact')
    })
  })

  describe('artifacts display', () => {
    it('should display recent artifacts', async () => {
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plans/plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
        {
          iteration: 2,
          type: 'review',
          file: 'reviews/plan-v2-arch.md',
          created_by: 'plan-reviewer-architecture',
          created_at: new Date().toISOString(),
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('Artifacts')
      expect(result.content[0].text).toContain('plan')
      expect(result.content[0].text).toContain('review')
    })

    it('should limit artifacts in non-verbose mode', async () => {
      mockWorkflowState.artifacts = Array.from({ length: 10 }, (_, i) => ({
        iteration: i + 1,
        type: 'plan' as const,
        file: `plans/plan-v${i + 1}.md`,
        created_by: 'plan-creator',
        created_at: new Date().toISOString(),
      }))

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        verbose: false,
      })

      // Should show "last X" in header
      expect(result.content[0].text).toContain('last')
    })
  })

  describe('feedback display', () => {
    it('should display unaddressed feedback', async () => {
      mockWorkflowState.feedback_history = [
        {
          iteration: 2,
          reviewer: 'plan-reviewer-architecture',
          feedback_file: 'reviews/arch.md',
          addressed: false,
          created_at: new Date().toISOString(),
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('Unaddressed Feedback')
      expect(result.content[0].text).toContain('plan-reviewer-architecture')
    })

    it('should not show unaddressed section if all addressed', async () => {
      mockWorkflowState.feedback_history = [
        {
          iteration: 1,
          reviewer: 'plan-reviewer-architecture',
          feedback_file: 'reviews/arch.md',
          addressed: true,
          created_at: new Date().toISOString(),
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).not.toContain('Unaddressed Feedback')
    })
  })

  describe('checkpoints display', () => {
    it('should display passed checkpoints', async () => {
      mockWorkflowState.checkpoints_passed = [
        {
          iteration: 1,
          decision: 'continue',
          decided_at: new Date().toISOString(),
        },
        {
          iteration: 1,
          decision: 'iterate',
          feedback: 'Need more details',
          decided_at: new Date().toISOString(),
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('Checkpoints')
      expect(result.content[0].text).toContain('continue')
      expect(result.content[0].text).toContain('iterate')
    })

    it('should show decision emojis', async () => {
      mockWorkflowState.checkpoints_passed = [
        {
          iteration: 1,
          decision: 'continue',
          decided_at: new Date().toISOString(),
        },
        {
          iteration: 1,
          decision: 'iterate',
          decided_at: new Date().toISOString(),
        },
        {
          iteration: 2,
          decision: 'approve',
          decided_at: new Date().toISOString(),
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('▶️') // continue
      expect(result.content[0].text).toContain('🔁') // iterate
      expect(result.content[0].text).toContain('✅') // approve
    })

    it('should include feedback in checkpoint display', async () => {
      mockWorkflowState.checkpoints_passed = [
        {
          iteration: 1,
          decision: 'iterate',
          feedback: 'Add error handling',
          decided_at: new Date().toISOString(),
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('Add error handling')
    })
  })

  describe('verbose mode', () => {
    it('should show full feedback history in verbose mode', async () => {
      mockWorkflowState.feedback_history = Array.from({ length: 10 }, (_, i) => ({
        iteration: i + 1,
        reviewer: `reviewer-${i + 1}`,
        feedback_file: `review-${i + 1}.md`,
        addressed: i % 2 === 0,
        created_at: new Date().toISOString(),
      }))

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        verbose: true,
      })

      expect(result.content[0].text).toContain('Feedback History')
    })

    it('should show agent runs in verbose mode', async () => {
      mockWorkflowState.agent_runs = [
        {
          agent: 'plan-creator',
          iteration: 1,
          context_files: ['requirements.md'],
          output_file: 'plan-v1.md',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          success: true,
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        verbose: true,
      })

      expect(result.content[0].text).toContain('Agent Runs')
      expect(result.content[0].text).toContain('plan-creator')
    })

    it('should show all artifacts in verbose mode', async () => {
      mockWorkflowState.artifacts = Array.from({ length: 10 }, (_, i) => ({
        iteration: i + 1,
        type: 'plan' as const,
        file: `plans/plan-v${i + 1}.md`,
        created_by: 'plan-creator',
        created_at: new Date().toISOString(),
      }))

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        verbose: true,
      })

      expect(result.content[0].text).toContain('all')
    })
  })

  describe('markdown formatting', () => {
    it('should use markdown table for overview', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('|')
      expect(result.content[0].text).toContain('---|')
    })

    it('should use heading for workflow ID', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('# Workflow Status')
    })

    it('should use subheadings for sections', async () => {
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan.md',
          created_by: 'creator',
          created_at: new Date().toISOString(),
        },
      ]

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.content[0].text).toContain('## ')
    })
  })

  describe('error handling', () => {
    it('should handle workflow manager errors', async () => {
      vi.mocked(mockWorkflowManager.getWorkflow).mockRejectedValue(new Error('Database error'))

      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error')
    })
  })
})
