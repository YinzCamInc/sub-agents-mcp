/**
 * Tests for StepWorkflowTool
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StepWorkflowTool } from '../StepWorkflowTool'

// Mock dependencies
const mockAgentExecutor = {
  executeAgent: vi.fn(),
}

const mockAgentManager = {
  getAgent: vi.fn(),
}

const mockWorkflowManager = {
  createWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  saveWorkflow: vi.fn(),
}

// Mock WorkflowLoader
vi.mock('src/workflow/WorkflowLoader', () => ({
  WorkflowLoader: vi.fn().mockImplementation(() => ({
    loadFromFile: vi.fn(),
    createDefaultWorkflow: vi.fn(),
    interpolate: vi.fn((s) => s),
    interpolateOutputs: vi.fn((o) => o),
  })),
}))

// Mock WorkflowExecutor
vi.mock('src/workflow/WorkflowExecutor', () => ({
  WorkflowExecutor: vi.fn().mockImplementation(() => ({
    startWorkflow: vi.fn(),
    executeStep: vi.fn(),
  })),
}))

describe('StepWorkflowTool', () => {
  let tool: StepWorkflowTool

  beforeEach(() => {
    tool = new StepWorkflowTool(
      mockAgentExecutor as never,
      mockAgentManager as never,
      mockWorkflowManager as never
    )
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('step_workflow')
    })

    it('should have description', () => {
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain('step')
    })

    it('should have input schema', () => {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties.workflow_id).toBeDefined()
      expect(tool.inputSchema.properties.workflow_file).toBeDefined()
      expect(tool.inputSchema.required).toContain('workflow_id')
    })
  })

  describe('execute', () => {
    it('should return error when workflow_id is missing', async () => {
      const result = await tool.execute({})

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should return error when workflow_id is not a string', async () => {
      const result = await tool.execute({ workflow_id: 123 })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should return error when workflow_file is not a string', async () => {
      const result = await tool.execute({
        workflow_id: 'test-workflow',
        workflow_file: 123,
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should return error when workflow not found', async () => {
      mockWorkflowManager.getWorkflow.mockResolvedValue(undefined)

      const result = await tool.execute({ workflow_id: 'nonexistent' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not found')
    })

    it('should return checkpoint message when at checkpoint', async () => {
      mockWorkflowManager.getWorkflow.mockResolvedValue({
        workflow_id: 'test-workflow',
        status: 'checkpoint',
        phase: 'planning',
        iteration: 1,
        checkpoint_message: 'Review the plan',
      })

      const result = await tool.execute({ workflow_id: 'test-workflow' })

      expect(result.isError).toBe(false)
      expect(result.content[0].text).toContain('Checkpoint')
      expect(result.content[0].text).toContain('continue_workflow')
    })

    it('should return completion message when workflow is complete', async () => {
      mockWorkflowManager.getWorkflow.mockResolvedValue({
        workflow_id: 'test-workflow',
        status: 'complete',
        phase: 'testing-execution',
        iteration: 2,
      })

      const result = await tool.execute({ workflow_id: 'test-workflow' })

      expect(result.isError).toBe(false)
      expect(result.content[0].text).toContain('Complete')
    })

    it('should return rejection message when workflow is rejected', async () => {
      mockWorkflowManager.getWorkflow.mockResolvedValue({
        workflow_id: 'test-workflow',
        status: 'rejected',
        phase: 'planning',
        iteration: 1,
      })

      const result = await tool.execute({ workflow_id: 'test-workflow' })

      expect(result.isError).toBe(false)
      expect(result.content[0].text).toContain('Rejected')
    })

    it('should validate params is an object', async () => {
      const result = await tool.execute('not-an-object')

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('object')
    })
  })
})
