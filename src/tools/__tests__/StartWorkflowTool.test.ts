/**
 * Tests for StartWorkflowTool
 */

import type { AgentDefinition } from 'src/types/AgentDefinition'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StartWorkflowTool } from '../StartWorkflowTool'

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

describe('StartWorkflowTool', () => {
  let tool: StartWorkflowTool

  beforeEach(() => {
    tool = new StartWorkflowTool(
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
      expect(tool.name).toBe('start_workflow')
    })

    it('should have description', () => {
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain('workflow')
    })

    it('should have input schema', () => {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties.workflow_file).toBeDefined()
      expect(tool.inputSchema.properties.workflow_id).toBeDefined()
      expect(tool.inputSchema.properties.input_file).toBeDefined()
      expect(tool.inputSchema.properties.use_default).toBeDefined()
    })
  })

  describe('execute', () => {
    it('should return error when neither workflow_file nor use_default is provided', async () => {
      const result = await tool.execute({})

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('workflow_file')
      expect(result.content[0].text).toContain('use_default')
    })

    it('should validate workflow_file parameter type', async () => {
      const result = await tool.execute({ workflow_file: 123 })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should validate workflow_id parameter type', async () => {
      const result = await tool.execute({
        use_default: true,
        workflow_id: 123,
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should validate input_file parameter type', async () => {
      const result = await tool.execute({
        use_default: true,
        input_file: 123,
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should validate use_default parameter type', async () => {
      const result = await tool.execute({
        use_default: 'not-a-boolean',
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('boolean')
    })

    it('should validate params is an object', async () => {
      const result = await tool.execute('not-an-object')

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('object')
    })
  })
})
