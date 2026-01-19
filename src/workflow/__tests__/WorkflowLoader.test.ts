/**
 * Tests for WorkflowLoader
 */

import type { InterpolationContext, WorkflowDefinition } from 'src/types/WorkflowDefinition'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLoader } from '../WorkflowLoader'

// Mock fs
vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(),
    },
  },
}))

// Import mocked fs after mocking
import fs from 'node:fs'

describe('WorkflowLoader', () => {
  let loader: WorkflowLoader

  beforeEach(() => {
    loader = new WorkflowLoader('/test/workflows')
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('loadFromString', () => {
    it('should parse valid YAML workflow definition', () => {
      const yaml = `
name: test-workflow
version: 1
phases:
  - id: planning
    type: iterative
    creator: plan-creator
    reviewers:
      - plan-reviewer-a
      - plan-reviewer-b
    verifiers:
      - plan-verifier-a
      - plan-verifier-b
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(true)
      expect(result.definition).toBeDefined()
      expect(result.definition?.name).toBe('test-workflow')
      expect(result.definition?.version).toBe(1)
      expect(result.definition?.phases).toHaveLength(1)
      expect(result.definition?.phases[0].id).toBe('planning')
    })

    it('should reject YAML without name', () => {
      const yaml = `
version: 1
phases:
  - id: planning
    type: iterative
    creator: plan-creator
    reviewers: [a]
    verifiers: [b]
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('name')
    })

    it('should reject YAML without version', () => {
      const yaml = `
name: test
phases:
  - id: planning
    type: iterative
    creator: plan-creator
    reviewers: [a]
    verifiers: [b]
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('version')
    })

    it('should reject YAML without phases', () => {
      const yaml = `
name: test
version: 1
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('phase')
    })

    it('should reject iterative phase without creator', () => {
      const yaml = `
name: test
version: 1
phases:
  - id: planning
    type: iterative
    reviewers: [a]
    verifiers: [b]
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('creator')
    })

    it('should reject iterative phase without reviewers', () => {
      const yaml = `
name: test
version: 1
phases:
  - id: planning
    type: iterative
    creator: plan-creator
    verifiers: [b]
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('reviewer')
    })

    it('should reject mismatched reviewer/verifier counts', () => {
      const yaml = `
name: test
version: 1
phases:
  - id: planning
    type: iterative
    creator: plan-creator
    reviewers: [a, b]
    verifiers: [c]
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('equal')
    })

    it('should reject test-execution phase without tester', () => {
      const yaml = `
name: test
version: 1
phases:
  - id: testing-execution
    type: test-execution
    fixer: implementer
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('tester')
    })

    it('should reject test-execution phase without fixer', () => {
      const yaml = `
name: test
version: 1
phases:
  - id: testing-execution
    type: test-execution
    tester: test-writer
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('fixer')
    })

    it('should parse test-execution phase correctly', () => {
      const yaml = `
name: test-workflow
version: 1
phases:
  - id: testing-execution
    type: test-execution
    tester: test-writer
    fixer: implementer
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(true)
      expect(result.definition?.phases[0].type).toBe('test-execution')
    })

    it('should apply default values', () => {
      const yaml = `
name: test
version: 1
phases:
  - id: planning
    type: iterative
    creator: plan-creator
    reviewers: [a]
    verifiers: [b]
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(true)
      expect(result.definition?.output_dir).toBe('.cursor/agents/workflow')
      expect(result.definition?.phases[0].min_iterations).toBe(1)
    })

    it('should handle invalid YAML syntax', () => {
      const yaml = `
name: test
version: 1
phases:
  - [invalid yaml
`
      const result = loader.loadFromString(yaml)

      expect(result.success).toBe(false)
      expect(result.error).toContain('YAML')
    })
  })

  describe('loadFromFile', () => {
    it('should load YAML file from disk', async () => {
      const yaml = `
name: file-workflow
version: 1
phases:
  - id: planning
    type: iterative
    creator: plan-creator
    reviewers: [a]
    verifiers: [b]
`
      vi.mocked(fs.promises.readFile).mockResolvedValue(yaml)

      const result = await loader.loadFromFile('test.yaml')

      expect(result.success).toBe(true)
      expect(result.definition?.name).toBe('file-workflow')
      expect(result.source_path).toContain('test.yaml')
    })

    it('should handle file not found', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      )

      const result = await loader.loadFromFile('nonexistent.yaml')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Failed')
    })
  })

  describe('interpolate', () => {
    it('should interpolate simple variables', () => {
      const context: InterpolationContext = {
        variables: { output_dir: '/test/output' },
        iteration: 1,
        phase: 'planning',
      }

      const result = loader.interpolate('{{ output_dir }}/file.md', context)

      expect(result).toBe('/test/output/file.md')
    })

    it('should interpolate iteration', () => {
      const context: InterpolationContext = {
        variables: {},
        iteration: 3,
        phase: 'planning',
      }

      const result = loader.interpolate('plan-v{{ iteration }}.md', context)

      expect(result).toBe('plan-v3.md')
    })

    it('should interpolate phase', () => {
      const context: InterpolationContext = {
        variables: {},
        iteration: 1,
        phase: 'implementation',
      }

      const result = loader.interpolate('{{ phase }}/output.md', context)

      expect(result).toBe('implementation/output.md')
    })

    it('should interpolate phase outputs', () => {
      const context: InterpolationContext = {
        variables: {},
        iteration: 1,
        phase: 'implementation',
        phases: {
          planning: {
            outputs: {
              artifact: '/plans/final.md',
            },
          },
        },
      }

      const result = loader.interpolate('{{ phases.planning.outputs.artifact }}', context)

      expect(result).toBe('/plans/final.md')
    })

    it('should leave unknown variables unchanged', () => {
      const context: InterpolationContext = {
        variables: {},
        iteration: 1,
        phase: 'planning',
      }

      const result = loader.interpolate('{{ unknown_var }}', context)

      expect(result).toBe('{{ unknown_var }}')
    })

    it('should handle multiple interpolations', () => {
      const context: InterpolationContext = {
        variables: { output_dir: '/out' },
        iteration: 2,
        phase: 'planning',
      }

      const result = loader.interpolate('{{ output_dir }}/{{ phase }}-v{{ iteration }}.md', context)

      expect(result).toBe('/out/planning-v2.md')
    })
  })

  describe('interpolateOutputs', () => {
    it('should interpolate all output paths', () => {
      const outputs = {
        artifact: '{{ output_dir }}/plans/plan-v{{ iteration }}.md',
        reviews: '{{ output_dir }}/reviews/',
      }
      const context: InterpolationContext = {
        variables: { output_dir: '/test' },
        iteration: 1,
        phase: 'planning',
      }

      const result = loader.interpolateOutputs(outputs, context)

      expect(result?.artifact).toBe('/test/plans/plan-v1.md')
      expect(result?.reviews).toBe('/test/reviews/')
    })

    it('should return undefined for undefined outputs', () => {
      const result = loader.interpolateOutputs(undefined, {
        variables: {},
        iteration: 1,
        phase: 'planning',
      })

      expect(result).toBeUndefined()
    })
  })

  describe('listWorkflows', () => {
    it('should list YAML files in workflow directory', async () => {
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.promises.readdir).mockResolvedValue([
        'workflow1.yaml',
        'workflow2.yml',
        'other.txt',
      ] as unknown as string[])

      const result = await loader.listWorkflows()

      expect(result).toEqual(['workflow1', 'workflow2'])
    })

    it('should return empty array on error', async () => {
      vi.mocked(fs.promises.mkdir).mockRejectedValue(new Error('Permission denied'))

      const result = await loader.listWorkflows()

      expect(result).toEqual([])
    })
  })

  describe('createDefaultWorkflow', () => {
    it('should create default workflow definition', async () => {
      vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined)

      const result = await loader.createDefaultWorkflow('my-workflow')

      expect(result.success).toBe(true)
      expect(result.definition?.name).toBe('my-workflow')
      expect(result.definition?.phases).toHaveLength(4)
      expect(result.definition?.phases[0].id).toBe('planning')
      expect(result.definition?.phases[1].id).toBe('implementation')
      expect(result.definition?.phases[2].id).toBe('testing-setup')
      expect(result.definition?.phases[3].id).toBe('testing-execution')

      expect(fs.promises.mkdir).toHaveBeenCalled()
      expect(fs.promises.writeFile).toHaveBeenCalled()
    })
  })
})
