/**
 * Tests for WorkflowManager
 */

import fs from 'node:fs'
import path from 'node:path'
import type { WorkflowState } from 'src/types/WorkflowState'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowManager } from '../WorkflowManager'

// Mock fs module
vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(),
      stat: vi.fn(),
      unlink: vi.fn(),
    },
  },
}))

const mockReadFile = vi.mocked(fs.promises.readFile)
const mockWriteFile = vi.mocked(fs.promises.writeFile)
const mockMkdir = vi.mocked(fs.promises.mkdir)
const mockReaddir = vi.mocked(fs.promises.readdir)
const mockUnlink = vi.mocked(fs.promises.unlink)

describe('WorkflowManager', () => {
  let workflowManager: WorkflowManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockReaddir.mockResolvedValue([])
    workflowManager = new WorkflowManager('/test/base')
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('createWorkflow', () => {
    it('should create a new workflow with default values', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })

      // Act
      const state = await workflowManager.createWorkflow('test-workflow')

      // Assert
      expect(state.workflow_id).toBe('test-workflow')
      expect(state.phase).toBe('planning')
      expect(state.iteration).toBe(1)
      expect(state.status).toBe('idle')
      expect(state.feedback_history).toEqual([])
      expect(state.artifacts).toEqual([])
      expect(state.checkpoints_passed).toEqual([])
      expect(state.agent_runs).toEqual([])
    })

    it('should create workflow with specified phase', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })

      // Act
      const state = await workflowManager.createWorkflow('test-workflow', 'implementation')

      // Assert
      expect(state.phase).toBe('implementation')
    })

    it('should throw error if workflow already exists', async () => {
      // Arrange
      const existingState: WorkflowState = {
        workflow_id: 'test-workflow',
        phase: 'planning',
        iteration: 1,
        status: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        feedback_history: [],
        artifacts: [],
        checkpoints_passed: [],
        agent_runs: [],
        reviewer_verifier_map: {},
      }
      mockReadFile.mockResolvedValue(JSON.stringify(existingState))

      // Act & Assert
      await expect(workflowManager.createWorkflow('test-workflow')).rejects.toThrow(
        'Workflow test-workflow already exists'
      )
    })
  })

  describe('getWorkflow', () => {
    it('should return undefined for non-existent workflow', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })

      // Act
      const state = await workflowManager.getWorkflow('non-existent')

      // Assert
      expect(state).toBeUndefined()
    })

    it('should return workflow from disk', async () => {
      // Arrange
      const existingState: WorkflowState = {
        workflow_id: 'test-workflow',
        phase: 'planning',
        iteration: 2,
        status: 'working',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        feedback_history: [],
        artifacts: [],
        checkpoints_passed: [],
        agent_runs: [],
        reviewer_verifier_map: {},
      }
      mockReadFile.mockResolvedValue(JSON.stringify(existingState))

      // Act
      const state = await workflowManager.getWorkflow('test-workflow')

      // Assert
      expect(state?.workflow_id).toBe('test-workflow')
      expect(state?.iteration).toBe(2)
      expect(state?.status).toBe('working')
    })

    it('should cache workflow after first load', async () => {
      // Arrange
      const existingState: WorkflowState = {
        workflow_id: 'test-workflow',
        phase: 'planning',
        iteration: 1,
        status: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        feedback_history: [],
        artifacts: [],
        checkpoints_passed: [],
        agent_runs: [],
        reviewer_verifier_map: {},
      }
      mockReadFile.mockResolvedValue(JSON.stringify(existingState))

      // Act
      await workflowManager.getWorkflow('test-workflow')
      await workflowManager.getWorkflow('test-workflow')

      // Assert - readFile should only be called once
      expect(mockReadFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('updateWorkflow', () => {
    it('should update workflow status', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.updateWorkflow('test-workflow', {
        status: 'working',
      })

      // Assert
      expect(updated.status).toBe('working')
    })

    it('should update workflow phase and iteration', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.updateWorkflow('test-workflow', {
        phase: 'implementation',
        iteration: 3,
      })

      // Assert
      expect(updated.phase).toBe('implementation')
      expect(updated.iteration).toBe(3)
    })

    it('should throw error for non-existent workflow', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })

      // Act & Assert
      await expect(
        workflowManager.updateWorkflow('non-existent', { status: 'working' })
      ).rejects.toThrow('Workflow non-existent not found')
    })
  })

  describe('addArtifact', () => {
    it('should add artifact to workflow', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.addArtifact('test-workflow', {
        type: 'plan',
        file: 'docs/plan.md',
        created_by: 'plan-creator',
      })

      // Assert
      expect(updated.artifacts).toHaveLength(1)
      expect(updated.artifacts[0].type).toBe('plan')
      expect(updated.artifacts[0].file).toBe('docs/plan.md')
      expect(updated.artifacts[0].created_by).toBe('plan-creator')
    })
  })

  describe('addFeedback', () => {
    it('should add feedback to workflow', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.addFeedback('test-workflow', {
        reviewer: 'plan-reviewer-architecture',
        feedback_file: 'docs/reviews/arch.md',
      })

      // Assert
      expect(updated.feedback_history).toHaveLength(1)
      expect(updated.feedback_history[0].reviewer).toBe('plan-reviewer-architecture')
      expect(updated.feedback_history[0].addressed).toBe(false)
    })
  })

  describe('recordCheckpoint', () => {
    it('should record continue decision', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.recordCheckpoint('test-workflow', 'continue')

      // Assert
      expect(updated.checkpoints_passed).toHaveLength(1)
      expect(updated.checkpoints_passed[0].decision).toBe('continue')
      expect(updated.status).toBe('working')
    })

    it('should increment iteration on iterate decision', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.recordCheckpoint(
        'test-workflow',
        'iterate',
        'Need more details'
      )

      // Assert
      expect(updated.iteration).toBe(2)
      expect(updated.status).toBe('working')
      expect(updated.checkpoints_passed[0].feedback).toBe('Need more details')
    })

    it('should mark workflow complete on approve decision', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.recordCheckpoint('test-workflow', 'approve')

      // Assert
      expect(updated.status).toBe('complete')
    })

    it('should mark workflow rejected on reject decision', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.recordCheckpoint(
        'test-workflow',
        'reject',
        'Not acceptable'
      )

      // Assert
      expect(updated.status).toBe('rejected')
    })
  })

  describe('pauseAtCheckpoint', () => {
    it('should pause workflow with message', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const updated = await workflowManager.pauseAtCheckpoint(
        'test-workflow',
        'Review required before proceeding'
      )

      // Assert
      expect(updated.status).toBe('checkpoint')
      expect(updated.checkpoint_message).toBe('Review required before proceeding')
    })
  })

  describe('getVerifierForReviewer', () => {
    it('should return mapped verifier', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const verifier = await workflowManager.getVerifierForReviewer(
        'test-workflow',
        'plan-reviewer-architecture'
      )

      // Assert
      expect(verifier).toBe('plan-verifier-architecture')
    })

    it('should return undefined for unknown reviewer', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const verifier = await workflowManager.getVerifierForReviewer(
        'test-workflow',
        'unknown-reviewer'
      )

      // Assert
      expect(verifier).toBeUndefined()
    })
  })

  describe('listWorkflows', () => {
    it('should return empty array when no workflows exist', async () => {
      // Arrange
      mockReaddir.mockResolvedValue([])

      // Act
      const workflows = await workflowManager.listWorkflows()

      // Assert
      expect(workflows).toEqual([])
    })

    it('should return all workflows sorted by updated_at', async () => {
      // Arrange
      const now = new Date()
      const older = new Date(now.getTime() - 1000)
      const workflow1: WorkflowState = {
        workflow_id: 'workflow-1',
        phase: 'planning',
        iteration: 1,
        status: 'idle',
        created_at: older.toISOString(),
        updated_at: older.toISOString(),
        feedback_history: [],
        artifacts: [],
        checkpoints_passed: [],
        agent_runs: [],
        reviewer_verifier_map: {},
      }
      const workflow2: WorkflowState = {
        workflow_id: 'workflow-2',
        phase: 'implementation',
        iteration: 2,
        status: 'working',
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        feedback_history: [],
        artifacts: [],
        checkpoints_passed: [],
        agent_runs: [],
        reviewer_verifier_map: {},
      }

      mockReaddir.mockResolvedValue([
        'workflow-1.json',
        'workflow-2.json',
      ] as unknown as fs.Dirent[])
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(workflow1))
        .mockResolvedValueOnce(JSON.stringify(workflow2))

      // Act
      const workflows = await workflowManager.listWorkflows()

      // Assert
      expect(workflows).toHaveLength(2)
      expect(workflows[0].workflow_id).toBe('workflow-2') // More recent first
      expect(workflows[1].workflow_id).toBe('workflow-1')
    })
  })

  describe('deleteWorkflow', () => {
    it('should delete workflow file', async () => {
      // Arrange
      mockReadFile.mockRejectedValue({ code: 'ENOENT' })
      mockUnlink.mockResolvedValue(undefined)
      await workflowManager.createWorkflow('test-workflow')

      // Act
      const result = await workflowManager.deleteWorkflow('test-workflow')

      // Assert
      expect(result).toBe(true)
      expect(mockUnlink).toHaveBeenCalled()
    })

    it('should return false for non-existent workflow', async () => {
      // Arrange
      mockUnlink.mockRejectedValue({ code: 'ENOENT' })

      // Act
      const result = await workflowManager.deleteWorkflow('non-existent')

      // Assert
      expect(result).toBe(false)
    })
  })
})
