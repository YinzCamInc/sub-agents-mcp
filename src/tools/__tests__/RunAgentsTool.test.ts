/**
 * Tests for RunAgentsTool
 *
 * Tests parallel execution of multiple agents with shared context.
 */

import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutionResult, AgentExecutor } from 'src/execution/AgentExecutor'
import type { AgentDefinition } from 'src/types/AgentDefinition'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunAgentsTool } from '../RunAgentsTool'

// Mock fs module
vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  },
}))

// Mock glob module
vi.mock('glob', () => ({
  glob: vi.fn(),
}))

// Import mocked modules
import fs from 'node:fs'
import { glob } from 'glob'

const mockReadFile = vi.mocked(fs.promises.readFile)
const mockWriteFile = vi.mocked(fs.promises.writeFile)
const mockMkdir = vi.mocked(fs.promises.mkdir)
const mockGlob = vi.mocked(glob)

describe('RunAgentsTool', () => {
  let tool: RunAgentsTool
  let mockAgentExecutor: AgentExecutor
  let mockAgentManager: AgentManager
  let mockWorkflowManager: WorkflowManager

  const mockExecutionResult: AgentExecutionResult = {
    stdout: 'Agent output content',
    stderr: '',
    exitCode: 0,
    executionTime: 100,
    hasResult: true,
  }

  const createMockAgentDefinition = (name: string): AgentDefinition => ({
    name,
    description: `${name} agent`,
    content: `# ${name}\nThis is the ${name} agent.`,
    filePath: `/agents/${name}.md`,
    lastModified: new Date('2025-01-01'),
    model: 'claude-opus-4-5',
  })

  beforeEach(() => {
    vi.clearAllMocks()

    mockAgentExecutor = {
      executeAgent: vi.fn().mockResolvedValue(mockExecutionResult),
    } as unknown as AgentExecutor

    mockAgentManager = {
      getAgent: vi
        .fn()
        .mockImplementation((name: string) => Promise.resolve(createMockAgentDefinition(name))),
      listAgents: vi.fn().mockResolvedValue([]),
    } as unknown as AgentManager

    mockWorkflowManager = {
      recordAgentRun: vi.fn().mockResolvedValue({ state: {}, runIndex: 0 }),
      completeAgentRun: vi.fn().mockResolvedValue({}),
    } as unknown as WorkflowManager

    mockReadFile.mockResolvedValue('Context file content')
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockGlob.mockResolvedValue([])

    tool = new RunAgentsTool(mockAgentExecutor, mockAgentManager, mockWorkflowManager)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('run_agents')
    })

    it('should have description mentioning parallel execution', () => {
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain('parallel')
    })

    it('should have input schema with required fields', () => {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties.agents).toBeDefined()
      expect(tool.inputSchema.properties.prompt).toBeDefined()
      expect(tool.inputSchema.properties.cwd).toBeDefined()
      expect(tool.inputSchema.required).toContain('agents')
      expect(tool.inputSchema.required).toContain('prompt')
      expect(tool.inputSchema.required).toContain('cwd')
    })

    it('should have optional parameters in schema', () => {
      expect(tool.inputSchema.properties.workflow_id).toBeDefined()
      expect(tool.inputSchema.properties.context_files).toBeDefined()
      expect(tool.inputSchema.properties.context_globs).toBeDefined()
      expect(tool.inputSchema.properties.context_data).toBeDefined()
      expect(tool.inputSchema.properties.output_dir).toBeDefined()
      expect(tool.inputSchema.properties.fail_fast).toBeDefined()
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

    it('should reject missing agents array', async () => {
      const result = await tool.execute({
        prompt: 'Test prompt',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('array')
    })

    it('should reject empty agents array', async () => {
      const result = await tool.execute({
        agents: [],
        prompt: 'Test prompt',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('At least one agent')
    })

    it('should reject too many agents (>10)', async () => {
      const tooManyAgents = Array.from({ length: 11 }, (_, i) => `agent-${i}`)
      const result = await tool.execute({
        agents: tooManyAgents,
        prompt: 'Test prompt',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('max 10')
    })

    it('should reject non-string agent names', async () => {
      const result = await tool.execute({
        agents: ['valid-agent', 123],
        prompt: 'Test prompt',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject missing prompt', async () => {
      const result = await tool.execute({
        agents: ['agent-1'],
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject empty prompt', async () => {
      const result = await tool.execute({
        agents: ['agent-1'],
        prompt: '',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('empty')
    })

    it('should reject missing cwd', async () => {
      const result = await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })

    it('should reject non-string workflow_id', async () => {
      const result = await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
        cwd: '/test',
        workflow_id: 123,
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string')
    })
  })

  describe('parallel execution', () => {
    it('should execute multiple agents in parallel', async () => {
      const result = await tool.execute({
        agents: ['agent-1', 'agent-2', 'agent-3'],
        prompt: 'Review this code',
        cwd: '/test/project',
      })

      expect(result.isError).not.toBe(true)
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledTimes(3)

      // All agents should receive the same prompt
      const calls = vi.mocked(mockAgentExecutor.executeAgent).mock.calls
      expect(calls[0][0].prompt).toContain('Review this code')
      expect(calls[1][0].prompt).toContain('Review this code')
      expect(calls[2][0].prompt).toContain('Review this code')
    })

    it('should report results for all agents', async () => {
      const result = await tool.execute({
        agents: ['agent-1', 'agent-2'],
        prompt: 'Test prompt',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('agent-1')
      expect(result.content[0].text).toContain('agent-2')
      expect(result.content[0].text).toContain('Total')
      expect(result.content[0].text).toContain('Successful')
    })

    it('should save outputs to files', async () => {
      await tool.execute({
        agents: ['agent-1', 'agent-2'],
        prompt: 'Test prompt',
        cwd: '/test',
      })

      expect(mockMkdir).toHaveBeenCalled()
      expect(mockWriteFile).toHaveBeenCalledTimes(2)
    })

    it('should use custom output directory when provided', async () => {
      await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
        cwd: '/test',
        output_dir: '/custom/output',
      })

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/custom/output'),
        expect.any(String),
        'utf-8'
      )
    })
  })

  describe('context injection', () => {
    it('should include context_files in prompt', async () => {
      mockReadFile.mockResolvedValue('File content here')

      await tool.execute({
        agents: ['agent-1'],
        prompt: 'Review code',
        cwd: '/test',
        context_files: ['file1.ts', 'file2.ts'],
      })

      expect(mockReadFile).toHaveBeenCalledTimes(2)
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('# Context'),
        })
      )
    })

    it('should expand context_globs and include matching files', async () => {
      mockGlob.mockResolvedValue(['review-1.md', 'review-2.md'])
      mockReadFile.mockResolvedValue('Review content')

      await tool.execute({
        agents: ['agent-1'],
        prompt: 'Verify reviews',
        cwd: '/test',
        context_globs: ['reviews/*.md'],
      })

      expect(mockGlob).toHaveBeenCalledWith(
        'reviews/*.md',
        expect.objectContaining({ cwd: '/test' })
      )
    })

    it('should include context_data in prompt', async () => {
      await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
        cwd: '/test',
        context_data: { iteration: 2, phase: 'planning' },
      })

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Context Data'),
        })
      )
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"iteration": 2'),
        })
      )
    })
  })

  describe('fail-fast mode', () => {
    it('should continue all executions when fail_fast is false', async () => {
      vi.mocked(mockAgentExecutor.executeAgent)
        .mockResolvedValueOnce({ ...mockExecutionResult, exitCode: 1, stderr: 'Error' })
        .mockResolvedValueOnce(mockExecutionResult)
        .mockResolvedValueOnce(mockExecutionResult)

      // Make getAgent return null for failed agent to trigger error
      vi.mocked(mockAgentManager.getAgent)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createMockAgentDefinition('agent-2'))
        .mockResolvedValueOnce(createMockAgentDefinition('agent-3'))

      const result = await tool.execute({
        agents: ['agent-1', 'agent-2', 'agent-3'],
        prompt: 'Test prompt',
        cwd: '/test',
        fail_fast: false,
      })

      // Should report partial success
      expect(result.content[0].text).toContain('Failed')
      expect(result.content[0].text).toContain('Successful')
    })

    it('should report failures correctly', async () => {
      vi.mocked(mockAgentManager.getAgent).mockResolvedValueOnce(null)

      const result = await tool.execute({
        agents: ['nonexistent-agent'],
        prompt: 'Test prompt',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('**Failed**: 1')
    })
  })

  describe('workflow integration', () => {
    it('should record agent runs when workflow_id is provided', async () => {
      await tool.execute({
        agents: ['agent-1', 'agent-2'],
        prompt: 'Test prompt',
        cwd: '/test',
        workflow_id: 'test-workflow',
      })

      expect(mockWorkflowManager.recordAgentRun).toHaveBeenCalledTimes(2)
      expect(mockWorkflowManager.completeAgentRun).toHaveBeenCalledTimes(2)
    })

    it('should not track runs when no workflow_id', async () => {
      await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
        cwd: '/test',
      })

      expect(mockWorkflowManager.recordAgentRun).not.toHaveBeenCalled()
    })

    it('should complete run with success status on successful execution', async () => {
      await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
        cwd: '/test',
        workflow_id: 'test-workflow',
      })

      expect(mockWorkflowManager.completeAgentRun).toHaveBeenCalledWith(
        'test-workflow',
        0, // runIndex
        true, // success
        undefined // no error
      )
    })
  })

  describe('error handling', () => {
    it('should handle agent not found gracefully', async () => {
      vi.mocked(mockAgentManager.getAgent).mockResolvedValue(undefined)

      const result = await tool.execute({
        agents: ['nonexistent'],
        prompt: 'Test prompt',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Failed')
    })

    it('should handle file read errors gracefully', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'))

      const result = await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
        cwd: '/test',
        context_files: ['nonexistent.ts'],
      })

      // Should still execute (file read failure is a warning)
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalled()
    })

    it('should handle executor errors gracefully', async () => {
      vi.mocked(mockAgentExecutor.executeAgent).mockRejectedValue(new Error('Execution failed'))

      const result = await tool.execute({
        agents: ['agent-1'],
        prompt: 'Test prompt',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Failed')
    })
  })

  describe('model selection', () => {
    it('should use model from agent frontmatter', async () => {
      const customAgent = createMockAgentDefinition('custom-agent')
      customAgent.model = 'gpt-5-2-codex'
      vi.mocked(mockAgentManager.getAgent).mockResolvedValue(customAgent)

      await tool.execute({
        agents: ['custom-agent'],
        prompt: 'Test prompt',
        cwd: '/test',
      })

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.2-codex',
        })
      )
    })
  })
})
