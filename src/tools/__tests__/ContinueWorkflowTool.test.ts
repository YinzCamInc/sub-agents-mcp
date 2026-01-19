/**
 * Tests for ContinueWorkflowTool
 *
 * Tests workflow continuation from checkpoints with different decisions.
 */

import type { WorkflowState } from 'src/types/WorkflowState'
import { createWorkflowState } from 'src/types/WorkflowState'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContinueWorkflowTool } from '../ContinueWorkflowTool'

describe('ContinueWorkflowTool', () => {
  let tool: ContinueWorkflowTool
  let mockWorkflowManager: WorkflowManager
  let mockWorkflowState: WorkflowState

  beforeEach(() => {
    vi.clearAllMocks()

    mockWorkflowState = createWorkflowState('test-workflow', 'planning')
    mockWorkflowState.status = 'checkpoint'
    mockWorkflowState.checkpoint_message = 'Review the plan'

    mockWorkflowManager = {
      getWorkflow: vi.fn().mockResolvedValue(mockWorkflowState),
      recordCheckpoint: vi.fn().mockImplementation((_id, decision) => {
        if (decision === 'iterate') {
          mockWorkflowState.iteration += 1
        }
        mockWorkflowState.status = decision === 'approve' ? 'complete' : 'working'
        return Promise.resolve(mockWorkflowState)
      }),
      updateWorkflow: vi.fn().mockResolvedValue(mockWorkflowState),
    } as unknown as WorkflowManager

    tool = new ContinueWorkflowTool(mockWorkflowManager)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('continue_workflow')
    })

    it('should have description', () => {
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain('checkpoint')
    })

    it('should have input schema with required fields', () => {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties.workflow_id).toBeDefined()
      expect(tool.inputSchema.properties.decision).toBeDefined()
      expect(tool.inputSchema.required).toContain('workflow_id')
      expect(tool.inputSchema.required).toContain('decision')
    })

    it('should have decision enum in schema', () => {
      expect(tool.inputSchema.properties.decision.enum).toEqual(['continue', 'iterate', 'approve'])
    })

    it('should have optional feedback parameter', () => {
      expect(tool.inputSchema.properties.feedback).toBeDefined()
    })

    it('should have optional next_phase parameter', () => {
      expect(tool.inputSchema.properties.next_phase).toBeDefined()
    })
  })

  describe('parameter validation', () => {
    it('should reject non-object params', async () => {
      const result = await tool.execute('not-an-object')
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('object')
    })

    it('should reject null params', async () => {
      const result = await tool.execute(null)
      expect(result.isError).toBe(true)
    })

    it('should reject missing workflow_id', async () => {
      const result = await tool.execute({
        decision: 'continue',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject non-string workflow_id', async () => {
      const result = await tool.execute({
        workflow_id: 123,
        decision: 'continue',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject missing decision', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject invalid decision', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'invalid',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('continue')
    })

    it('should require feedback when decision is iterate', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'iterate',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Feedback is required')
    })

    it('should reject non-string feedback', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'iterate',
        feedback: 123,
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject invalid next_phase', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'approve',
        next_phase: 'invalid-phase',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('must be one of')
    })
  })

  describe('workflow not found', () => {
    it('should return error if workflow does not exist', async () => {
      vi.mocked(mockWorkflowManager.getWorkflow).mockResolvedValue(undefined)

      const result = await tool.execute({
        workflow_id: 'nonexistent',
        decision: 'continue',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not found')
    })
  })

  describe('workflow not at checkpoint', () => {
    it('should return error if workflow is not at checkpoint', async () => {
      mockWorkflowState.status = 'working'

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'continue',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not at a checkpoint')
    })
  })

  describe('continue decision', () => {
    it('should record continue decision', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'continue',
      })

      expect(mockWorkflowManager.recordCheckpoint).toHaveBeenCalledWith(
        'test-workflow',
        'continue',
        undefined
      )
      expect(result.isError).not.toBe(true)
      expect(result.content[0].text).toContain('resumed')
    })

    it('should include phase and iteration in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'continue',
      })

      expect(result.content[0].text).toContain('planning')
      expect(result.content[0].text).toContain('Iteration')
    })
  })

  describe('iterate decision', () => {
    it('should record iterate decision with feedback', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'iterate',
        feedback: 'Need more details on security',
      })

      expect(mockWorkflowManager.recordCheckpoint).toHaveBeenCalledWith(
        'test-workflow',
        'iterate',
        'Need more details on security'
      )
      expect(result.isError).not.toBe(true)
    })

    it('should show iteration number in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'iterate',
        feedback: 'Add error handling',
      })

      expect(result.content[0].text).toContain('iteration')
      expect(result.content[0].text).toContain('feedback')
    })

    it('should include feedback in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'iterate',
        feedback: 'Missing validation logic',
      })

      expect(result.content[0].text).toContain('Missing validation logic')
    })
  })

  describe('approve decision', () => {
    it('should record approve decision', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'approve',
      })

      expect(mockWorkflowManager.recordCheckpoint).toHaveBeenCalledWith(
        'test-workflow',
        'approve',
        undefined
      )
      expect(result.isError).not.toBe(true)
    })

    it('should mark phase as approved in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'approve',
      })

      expect(result.content[0].text).toContain('approved')
    })

    it('should transition to next_phase when specified', async () => {
      await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'approve',
        next_phase: 'implementation',
      })

      expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith('test-workflow', {
        phase: 'implementation',
        iteration: 1,
        status: 'working',
      })
    })

    it('should mention next phase in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'approve',
        next_phase: 'implementation',
      })

      expect(result.content[0].text).toContain('implementation')
    })

    it('should work without next_phase (complete current phase)', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'approve',
      })

      expect(mockWorkflowManager.updateWorkflow).not.toHaveBeenCalled()
      expect(result.content[0].text).toContain('complete')
    })
  })

  describe('response format', () => {
    it('should include workflow ID in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'continue',
      })

      expect(result.content[0].text).toContain('test-workflow')
    })

    it('should include decision in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'continue',
      })

      expect(result.content[0].text).toContain('continue')
    })

    it('should use markdown formatting', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'continue',
      })

      expect(result.content[0].text).toContain('#')
      expect(result.content[0].text).toContain('**')
    })
  })

  describe('error handling', () => {
    it('should handle workflow manager errors', async () => {
      vi.mocked(mockWorkflowManager.recordCheckpoint).mockRejectedValue(new Error('Database error'))

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        decision: 'continue',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error')
    })
  })
})
