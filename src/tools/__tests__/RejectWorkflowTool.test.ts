/**
 * Tests for RejectWorkflowTool
 *
 * Tests workflow rejection with detailed feedback and restart options.
 */

import type { WorkflowState } from 'src/types/WorkflowState'
import { createWorkflowState } from 'src/types/WorkflowState'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RejectWorkflowTool } from '../RejectWorkflowTool'

describe('RejectWorkflowTool', () => {
  let tool: RejectWorkflowTool
  let mockWorkflowManager: WorkflowManager
  let mockWorkflowState: WorkflowState

  beforeEach(() => {
    vi.clearAllMocks()

    mockWorkflowState = createWorkflowState('test-workflow', 'implementation')
    mockWorkflowState.iteration = 2
    mockWorkflowState.status = 'checkpoint'

    mockWorkflowManager = {
      getWorkflow: vi.fn().mockResolvedValue(mockWorkflowState),
      recordCheckpoint: vi.fn().mockImplementation(() => {
        mockWorkflowState.status = 'rejected'
        return Promise.resolve(mockWorkflowState)
      }),
      updateWorkflow: vi.fn().mockResolvedValue(mockWorkflowState),
    } as unknown as WorkflowManager

    tool = new RejectWorkflowTool(mockWorkflowManager)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('reject_workflow')
    })

    it('should have description', () => {
      expect(tool.description).toBeTruthy()
      expect(tool.description.toLowerCase()).toContain('reject')
    })

    it('should have input schema with required fields', () => {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties.workflow_id).toBeDefined()
      expect(tool.inputSchema.properties.reason).toBeDefined()
      expect(tool.inputSchema.required).toContain('workflow_id')
      expect(tool.inputSchema.required).toContain('reason')
    })

    it('should have optional required_changes parameter', () => {
      expect(tool.inputSchema.properties.required_changes).toBeDefined()
      expect(tool.inputSchema.properties.required_changes.type).toBe('array')
    })

    it('should have optional restart_from parameter', () => {
      expect(tool.inputSchema.properties.restart_from).toBeDefined()
      expect(tool.inputSchema.properties.restart_from.enum).toContain('planning')
      expect(tool.inputSchema.properties.restart_from.enum).toContain('current')
    })
  })

  describe('parameter validation', () => {
    it('should reject non-object params', async () => {
      const result = await tool.execute('not-an-object')
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('object')
    })

    it('should reject missing workflow_id', async () => {
      const result = await tool.execute({
        reason: 'Not good enough',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject non-string workflow_id', async () => {
      const result = await tool.execute({
        workflow_id: 123,
        reason: 'Not good enough',
      })
      expect(result.isError).toBe(true)
    })

    it('should reject missing reason', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
      })
      expect(result.isError).toBe(true)
    })

    it('should reject too short reason (<10 chars)', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Short',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('detailed')
    })

    it('should reject non-array required_changes', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'This implementation has issues',
        required_changes: 'not-an-array',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('array')
    })

    it('should reject non-string items in required_changes', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'This implementation has issues',
        required_changes: ['valid change', 123],
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject invalid restart_from phase', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'This implementation has issues',
        restart_from: 'invalid-phase',
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
        reason: 'This should not work',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not found')
    })
  })

  describe('basic rejection', () => {
    it('should record rejection with reason', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'The architecture does not meet requirements',
      })

      expect(mockWorkflowManager.recordCheckpoint).toHaveBeenCalledWith(
        'test-workflow',
        'reject',
        expect.stringContaining('The architecture does not meet requirements')
      )
      expect(result.isError).not.toBe(true)
    })

    it('should include reason in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Security vulnerabilities found',
      })

      expect(result.content[0].text).toContain('Security vulnerabilities found')
    })

    it('should show workflow and phase info', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Missing error handling',
      })

      expect(result.content[0].text).toContain('test-workflow')
      expect(result.content[0].text).toContain('implementation')
      expect(result.content[0].text).toContain('Iteration')
    })
  })

  describe('required_changes', () => {
    it('should include required changes in feedback', async () => {
      await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Multiple issues found',
        required_changes: ['Add input validation', 'Fix memory leak', 'Update error messages'],
      })

      expect(mockWorkflowManager.recordCheckpoint).toHaveBeenCalledWith(
        'test-workflow',
        'reject',
        expect.stringContaining('Add input validation')
      )
    })

    it('should display required changes as checklist', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Multiple issues found',
        required_changes: ['Add input validation', 'Fix memory leak'],
      })

      expect(result.content[0].text).toContain('Required Changes')
      expect(result.content[0].text).toContain('Add input validation')
      expect(result.content[0].text).toContain('Fix memory leak')
      expect(result.content[0].text).toContain('[ ]') // Checkbox format
    })

    it('should work without required_changes', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Not meeting quality standards',
      })

      expect(result.isError).not.toBe(true)
    })
  })

  describe('restart_from', () => {
    it('should restart from specified phase', async () => {
      await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Need to reconsider architecture',
        restart_from: 'planning',
      })

      expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith('test-workflow', {
        phase: 'planning',
        iteration: 1,
        status: 'idle',
        checkpoint_message: expect.any(String),
      })
    })

    it('should restart from current phase when "current"', async () => {
      await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Need another iteration',
        restart_from: 'current',
      })

      expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith('test-workflow', {
        phase: 'implementation', // Current phase
        iteration: 1,
        status: 'idle',
        checkpoint_message: expect.any(String),
      })
    })

    it('should show restart message in response', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Fundamental issues',
        restart_from: 'planning',
      })

      expect(result.content[0].text).toContain('restart')
      expect(result.content[0].text).toContain('planning')
    })

    it('should work without restart_from', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'This approach will not work',
      })

      expect(mockWorkflowManager.updateWorkflow).not.toHaveBeenCalled()
      expect(result.isError).not.toBe(true)
    })

    it('should support all valid phases', async () => {
      const phases = ['planning', 'implementation', 'testing-setup', 'testing-execution'] as const

      for (const phase of phases) {
        vi.clearAllMocks()

        await tool.execute({
          workflow_id: 'test-workflow',
          reason: 'Restart needed for testing',
          restart_from: phase,
        })

        expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith(
          'test-workflow',
          expect.objectContaining({
            phase,
            iteration: 1,
          })
        )
      }
    })
  })

  describe('response format', () => {
    it('should use markdown formatting', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Quality issues detected',
      })

      expect(result.content[0].text).toContain('# Workflow Rejected')
      expect(result.content[0].text).toContain('**')
      expect(result.content[0].text).toContain('❌')
    })

    it('should show rejection marker', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Not acceptable',
      })

      expect(result.content[0].text).toContain('rejected')
    })
  })

  describe('error handling', () => {
    it('should handle workflow manager errors', async () => {
      vi.mocked(mockWorkflowManager.recordCheckpoint).mockRejectedValue(new Error('Database error'))

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'This should fail',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Error')
    })

    it('should handle update errors gracefully', async () => {
      vi.mocked(mockWorkflowManager.updateWorkflow).mockRejectedValue(new Error('Update failed'))

      const result = await tool.execute({
        workflow_id: 'test-workflow',
        reason: 'Restart needed',
        restart_from: 'planning',
      })

      expect(result.isError).toBe(true)
    })
  })
})
