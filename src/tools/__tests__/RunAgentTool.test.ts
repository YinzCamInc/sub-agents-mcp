/**
 * Unit tests for RunAgentTool new parameters (Phase 1 features)
 *
 * Tests for output file writing, model selection, and context_files functionality.
 */

import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutionResult, AgentExecutor } from 'src/execution/AgentExecutor'
import { RunAgentTool } from 'src/tools/RunAgentTool'
import type { AgentDefinition } from 'src/types/AgentDefinition'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('RunAgentTool - Phase 1 Parameters', () => {
  let runAgentTool: RunAgentTool
  let mockAgentExecutor: AgentExecutor
  let mockAgentManager: AgentManager

  const mockExecutionResult: AgentExecutionResult = {
    stdout: JSON.stringify({ result: 'Test output from agent' }),
    stderr: '',
    exitCode: 0,
    executionTime: 100,
    hasResult: true,
    resultJson: { result: 'Test output from agent' },
  }

  const mockAgentDefinition: AgentDefinition = {
    name: 'test-agent',
    description: 'Test agent',
    content: '# Test Agent\nThis is a test agent.',
    filePath: '/agents/test-agent.md',
    lastModified: new Date('2025-01-01'),
    model: 'claude-opus-4-5',
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mockAgentExecutor = {
      executeAgent: vi.fn().mockResolvedValue(mockExecutionResult),
    } as unknown as AgentExecutor

    mockAgentManager = {
      getAgent: vi.fn().mockResolvedValue(mockAgentDefinition),
      listAgents: vi.fn().mockResolvedValue([mockAgentDefinition]),
    } as unknown as AgentManager

    mockReadFile.mockResolvedValue('Context file content')
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockGlob.mockResolvedValue([])

    runAgentTool = new RunAgentTool(mockAgentExecutor, mockAgentManager)
  })

  describe('Model Selection', () => {
    it('should use model from agent frontmatter when no override provided', async () => {
      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
      })

      // Assert
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-opus-4.5', // Mapped from claude-opus-4-5
        })
      )
    })

    it('should use model override when provided', async () => {
      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        model: 'claude-sonnet-4-5',
      })

      // Assert
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4.5', // Mapped from claude-sonnet-4-5
        })
      )
    })

    it('should use gpt-5-2-codex model when specified', async () => {
      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        model: 'gpt-5-2-codex',
      })

      // Assert
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.2-codex', // Mapped from gpt-5-2-codex
        })
      )
    })

    it('should reject invalid model parameter', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        model: 'invalid-model',
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('Invalid model parameter')
    })
  })

  describe('Output File Writing', () => {
    it('should write output to file when output parameter provided', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        output: 'output.md',
      })

      // Assert
      expect(mockMkdir).toHaveBeenCalled()
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('output.md'),
        expect.any(String),
        'utf-8'
      )
      expect(result.isError).not.toBe(true)
    })

    it('should include output_path in response when output written', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        output: 'output.md',
      })

      // Assert
      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.output_path).toBeDefined()
      expect(responseData.output_path).toContain('output.md')
    })

    it('should handle absolute output path', async () => {
      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        output: '/absolute/path/output.md',
      })

      // Assert
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/absolute/path/output.md',
        expect.any(String),
        'utf-8'
      )
    })

    it('should continue execution if output write fails', async () => {
      // Arrange
      mockWriteFile.mockRejectedValue(new Error('Write failed'))

      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        output: 'output.md',
      })

      // Assert - Should still return success (output write is best-effort)
      expect(result.isError).not.toBe(true)
    })

    it('should reject empty output parameter', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        output: '',
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('output')
    })
  })

  describe('Context Files', () => {
    it('should read and include context files in prompt', async () => {
      // Arrange
      mockReadFile.mockResolvedValue('File content here')

      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_files: ['file1.ts', 'file2.ts'],
      })

      // Assert
      expect(mockReadFile).toHaveBeenCalledTimes(2)
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('# Context'),
        })
      )
    })

    it('should include file path in context', async () => {
      // Arrange
      mockReadFile.mockResolvedValue('File content')

      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_files: ['src/index.ts'],
      })

      // Assert
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('## File: src/index.ts'),
        })
      )
    })

    it('should continue if context file read fails', async () => {
      // Arrange
      mockReadFile.mockRejectedValue(new Error('File not found'))

      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_files: ['nonexistent.ts'],
      })

      // Assert - Should still execute (failed context read is warning only)
      expect(result.isError).not.toBe(true)
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalled()
    })

    it('should reject too many context files', async () => {
      // Arrange
      const tooManyFiles = Array.from({ length: 21 }, (_, i) => `file${i}.ts`)

      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_files: tooManyFiles,
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('max 20')
    })

    it('should reject non-array context_files parameter', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_files: 'not-an-array' as unknown as string[],
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('array')
    })
  })

  describe('Context Globs', () => {
    it('should expand glob patterns and include matching files', async () => {
      // Arrange - mock glob to return files
      mockGlob.mockResolvedValue(['review-1.md', 'review-2.md'])
      mockReadFile
        .mockResolvedValueOnce('Review 1 content')
        .mockResolvedValueOnce('Review 2 content')

      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_globs: ['reviews/*.md'],
      })

      // Assert
      expect(mockGlob).toHaveBeenCalledWith(
        'reviews/*.md',
        expect.objectContaining({ cwd: '/test/dir' })
      )
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('# Context'),
        })
      )
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('## File: review-1.md'),
        })
      )
    })

    it('should reject too many glob patterns', async () => {
      // Arrange
      const tooManyGlobs = Array.from({ length: 11 }, (_, i) => `pattern${i}/*.md`)

      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_globs: tooManyGlobs,
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('max 10')
    })

    it('should reject non-array context_globs parameter', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_globs: 'not-an-array' as unknown as string[],
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('array')
    })

    it('should continue if glob pattern expansion fails', async () => {
      // Note: glob errors are handled gracefully, execution continues

      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_globs: ['invalid[pattern'],
      })

      // Assert - Should still execute (failed glob is warning only)
      expect(result.isError).not.toBe(true)
    })
  })

  describe('Context Data', () => {
    it('should include structured context data in prompt', async () => {
      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_data: {
          iteration: 2,
          phase: 'planning',
          task: 'Incorporate reviewer feedback',
        },
      })

      // Assert
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
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('"phase": "planning"'),
        })
      )
    })

    it('should reject non-object context_data parameter', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_data: 'not-an-object' as unknown as Record<string, unknown>,
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('object')
    })

    it('should reject array as context_data parameter', async () => {
      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_data: ['not', 'an', 'object'] as unknown as Record<string, unknown>,
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('object')
    })

    it('should reject context_data that is too large', async () => {
      // Arrange - create a large object (> 50KB when serialized)
      const largeData: Record<string, string> = {}
      for (let i = 0; i < 1000; i++) {
        largeData[`key${i}`] = 'x'.repeat(100)
      }

      // Act
      const result = await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_data: largeData,
      })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('too large')
    })
  })

  describe('Combined Context', () => {
    it('should combine context_files, context_globs, and context_data', async () => {
      // Arrange
      mockReadFile.mockResolvedValue('File content')

      // Act
      await runAgentTool.execute({
        agent: 'test-agent',
        prompt: 'Test prompt',
        cwd: '/test/dir',
        context_files: ['file1.md'],
        context_data: { iteration: 1 },
      })

      // Assert - prompt should contain both file content and context data
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringMatching(
            /# Context[\s\S]*File: file1\.md[\s\S]*Context Data[\s\S]*"iteration": 1/
          ),
        })
      )
    })
  })

  describe('Input Schema', () => {
    it('should include output in input schema', () => {
      expect(runAgentTool.inputSchema.properties['output']).toBeDefined()
      expect(runAgentTool.inputSchema.properties['output'].type).toBe('string')
    })

    it('should include model in input schema', () => {
      expect(runAgentTool.inputSchema.properties['model']).toBeDefined()
      expect(runAgentTool.inputSchema.properties['model'].type).toBe('string')
    })

    it('should include context_files in input schema', () => {
      expect(runAgentTool.inputSchema.properties['context_files']).toBeDefined()
      expect(runAgentTool.inputSchema.properties['context_files'].type).toBe('array')
    })

    it('should include context_globs in input schema', () => {
      expect(runAgentTool.inputSchema.properties['context_globs']).toBeDefined()
      expect(runAgentTool.inputSchema.properties['context_globs'].type).toBe('array')
    })

    it('should include context_data in input schema', () => {
      expect(runAgentTool.inputSchema.properties['context_data']).toBeDefined()
      expect(runAgentTool.inputSchema.properties['context_data'].type).toBe('object')
    })
  })
})
