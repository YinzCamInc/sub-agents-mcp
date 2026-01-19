/**
 * Tests for RunVerifiersTool
 *
 * Tests verifier execution with automatic reviewer→verifier mapping.
 */

import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutionResult, AgentExecutor } from 'src/execution/AgentExecutor'
import type { AgentDefinition } from 'src/types/AgentDefinition'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunVerifiersTool } from '../RunVerifiersTool'

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

// Import mocked modules
import fs from 'node:fs'

const mockReadFile = vi.mocked(fs.promises.readFile)
const mockWriteFile = vi.mocked(fs.promises.writeFile)
const mockMkdir = vi.mocked(fs.promises.mkdir)

describe('RunVerifiersTool', () => {
  let tool: RunVerifiersTool
  let mockAgentExecutor: AgentExecutor
  let mockAgentManager: AgentManager
  let mockWorkflowManager: WorkflowManager

  const mockExecutionResult: AgentExecutionResult = {
    stdout: 'Verification output: All feedback addressed. No critical issues.',
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
    } as unknown as AgentManager

    mockWorkflowManager = {
      recordAgentRun: vi.fn().mockResolvedValue({ state: {}, runIndex: 0 }),
      completeAgentRun: vi.fn().mockResolvedValue({}),
    } as unknown as WorkflowManager

    mockReadFile.mockResolvedValue('File content')
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)

    tool = new RunVerifiersTool(mockAgentExecutor, mockAgentManager, mockWorkflowManager)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(tool.name).toBe('run_verifiers')
    })

    it('should have description mentioning reviewer→verifier mapping', () => {
      expect(tool.description).toBeTruthy()
      expect(tool.description).toContain('reviewer')
      expect(tool.description).toContain('verifier')
    })

    it('should have input schema with required fields', () => {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.properties.review_files).toBeDefined()
      expect(tool.inputSchema.properties.artifact_file).toBeDefined()
      expect(tool.inputSchema.properties.prompt).toBeDefined()
      expect(tool.inputSchema.properties.cwd).toBeDefined()
      expect(tool.inputSchema.required).toContain('review_files')
      expect(tool.inputSchema.required).toContain('artifact_file')
      expect(tool.inputSchema.required).toContain('prompt')
      expect(tool.inputSchema.required).toContain('cwd')
    })

    it('should have optional parameters in schema', () => {
      expect(tool.inputSchema.properties.workflow_id).toBeDefined()
      expect(tool.inputSchema.properties.output_dir).toBeDefined()
      expect(tool.inputSchema.properties.custom_mapping).toBeDefined()
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

    it('should reject missing review_files', async () => {
      const result = await tool.execute({
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('array')
    })

    it('should reject empty review_files array', async () => {
      const result = await tool.execute({
        review_files: [],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('At least one')
    })

    it('should reject review_files without reviewer field', async () => {
      const result = await tool.execute({
        review_files: [{ file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('reviewer')
    })

    it('should reject review_files without file field', async () => {
      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('file')
    })

    it('should reject missing artifact_file', async () => {
      const result = await tool.execute({
        review_files: [{ reviewer: 'reviewer', file: 'review.md' }],
        prompt: 'Verify feedback',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
    })

    it('should reject missing prompt', async () => {
      const result = await tool.execute({
        review_files: [{ reviewer: 'reviewer', file: 'review.md' }],
        artifact_file: 'plan.md',
        cwd: '/test',
      })
      expect(result.isError).toBe(true)
    })

    it('should reject missing cwd', async () => {
      const result = await tool.execute({
        review_files: [{ reviewer: 'reviewer', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
      })
      expect(result.isError).toBe(true)
    })
  })

  describe('reviewer→verifier mapping', () => {
    it('should use default mapping for plan reviewers', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review-arch.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify the feedback',
        cwd: '/test',
      })

      // Should call the corresponding verifier
      expect(mockAgentManager.getAgent).toHaveBeenCalledWith('plan-verifier-architecture')
    })

    it('should use default mapping for code reviewers', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'code-reviewer-logic', file: 'review-logic.md' }],
        artifact_file: 'code.ts',
        prompt: 'Verify the feedback',
        cwd: '/test',
      })

      expect(mockAgentManager.getAgent).toHaveBeenCalledWith('code-verifier-logic')
    })

    it('should use default mapping for test reviewers', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'test-reviewer-coverage', file: 'review-coverage.md' }],
        artifact_file: 'tests.ts',
        prompt: 'Verify the feedback',
        cwd: '/test',
      })

      expect(mockAgentManager.getAgent).toHaveBeenCalledWith('test-verifier-coverage')
    })

    it('should use custom mapping when provided', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'custom-reviewer', file: 'review.md' }],
        artifact_file: 'artifact.md',
        prompt: 'Verify feedback',
        cwd: '/test',
        custom_mapping: {
          'custom-reviewer': 'custom-verifier',
        },
      })

      expect(mockAgentManager.getAgent).toHaveBeenCalledWith('custom-verifier')
    })

    it('should skip reviewers without mapping', async () => {
      mockReadFile.mockResolvedValue('Content')

      const result = await tool.execute({
        review_files: [{ reviewer: 'unknown-reviewer', file: 'review.md' }],
        artifact_file: 'artifact.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Skipped')
      expect(result.content[0].text).toContain('unknown-reviewer')
    })
  })

  describe('context injection', () => {
    it('should provide artifact content to verifier', async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('plan.md')) {
          return Promise.resolve('Plan content here')
        }
        return Promise.resolve('Review content')
      })

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Plan content here'),
        })
      )
    })

    it('should provide reviewer feedback to verifier', async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('review.md')) {
          return Promise.resolve('Reviewer feedback content')
        }
        return Promise.resolve('Artifact content')
      })

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('Reviewer feedback content'),
        })
      )
    })

    it('should include reviewer name in context', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('plan-reviewer-architecture'),
        })
      )
    })
  })

  describe('issue parsing', () => {
    it('should count issues in verifier output', async () => {
      vi.mocked(mockAgentExecutor.executeAgent).mockResolvedValue({
        ...mockExecutionResult,
        stdout:
          'Issue: Missing error handling\nIssue: No validation\nProblem: Edge case not covered',
      })

      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Issues:')
    })

    it('should count critical issues separately', async () => {
      vi.mocked(mockAgentExecutor.executeAgent).mockResolvedValue({
        ...mockExecutionResult,
        stdout:
          'Critical: Security vulnerability\nCritical: Data loss risk\nIssue: Minor formatting',
      })

      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-security', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Critical')
      expect(result.content[0].text).toContain('CRITICAL')
    })

    it('should provide recommendation based on results', async () => {
      vi.mocked(mockAgentExecutor.executeAgent).mockResolvedValue({
        ...mockExecutionResult,
        stdout: 'All feedback addressed. No issues found.',
      })

      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Recommendation')
      expect(result.content[0].text).toContain('passed')
    })
  })

  describe('parallel execution', () => {
    it('should run multiple verifiers in parallel', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [
          { reviewer: 'plan-reviewer-architecture', file: 'review-arch.md' },
          { reviewer: 'plan-reviewer-integration', file: 'review-int.md' },
          { reviewer: 'plan-reviewer-security', file: 'review-sec.md' },
        ],
        artifact_file: 'plan.md',
        prompt: 'Verify all feedback',
        cwd: '/test',
      })

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledTimes(3)
    })

    it('should report results for all verifiers', async () => {
      mockReadFile.mockResolvedValue('Content')

      const result = await tool.execute({
        review_files: [
          { reviewer: 'plan-reviewer-architecture', file: 'review-arch.md' },
          { reviewer: 'plan-reviewer-integration', file: 'review-int.md' },
        ],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('plan-verifier-architecture')
      expect(result.content[0].text).toContain('plan-verifier-integration')
      expect(result.content[0].text).toContain('Total Verifiers')
    })
  })

  describe('output file management', () => {
    it('should save verification outputs to files', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(mockMkdir).toHaveBeenCalled()
      expect(mockWriteFile).toHaveBeenCalled()
    })

    it('should use custom output directory when provided', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
        output_dir: '/custom/verifications',
      })

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('/custom/verifications'),
        expect.any(String),
        'utf-8'
      )
    })

    it('should include output path in response', async () => {
      mockReadFile.mockResolvedValue('Content')

      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Output:')
    })
  })

  describe('workflow integration', () => {
    it('should record agent runs when workflow_id is provided', async () => {
      mockReadFile.mockResolvedValue('Content')

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
        workflow_id: 'test-workflow',
      })

      expect(mockWorkflowManager.recordAgentRun).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should handle artifact file read error', async () => {
      mockReadFile.mockRejectedValue(new Error('File not found'))

      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'nonexistent.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.isError).toBe(true)
    })

    it('should handle review file read error gracefully', async () => {
      mockReadFile.mockImplementation((path: string) => {
        if (path.includes('artifact')) {
          return Promise.resolve('Artifact content')
        }
        return Promise.reject(new Error('Review file not found'))
      })

      // The tool should skip this reviewer but not fail entirely
      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'nonexistent-review.md' }],
        artifact_file: '/test/artifact.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      // Should not have executed any verifiers due to read error
      expect(mockAgentExecutor.executeAgent).not.toHaveBeenCalled()
    })

    it('should handle verifier not found', async () => {
      mockReadFile.mockResolvedValue('Content')
      vi.mocked(mockAgentManager.getAgent).mockResolvedValue(undefined)

      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('not found')
    })

    it('should handle executor errors gracefully', async () => {
      mockReadFile.mockResolvedValue('Content')
      vi.mocked(mockAgentExecutor.executeAgent).mockRejectedValue(new Error('Execution failed'))

      const result = await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
        cwd: '/test',
      })

      expect(result.content[0].text).toContain('Failed')
    })
  })

  describe('model selection', () => {
    it('should use model from verifier agent definition', async () => {
      mockReadFile.mockResolvedValue('Content')
      const verifierAgent = createMockAgentDefinition('plan-verifier-architecture')
      verifierAgent.model = 'gpt-5-2-codex'
      vi.mocked(mockAgentManager.getAgent).mockResolvedValue(verifierAgent)

      await tool.execute({
        review_files: [{ reviewer: 'plan-reviewer-architecture', file: 'review.md' }],
        artifact_file: 'plan.md',
        prompt: 'Verify feedback',
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
