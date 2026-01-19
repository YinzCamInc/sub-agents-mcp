/**
 * Tests for WorkflowExecutor
 *
 * Tests execution of workflow phases with agent coordination.
 */

import type { AgentManager } from 'src/agents/AgentManager'
import type { AgentExecutionResult, AgentExecutor } from 'src/execution/AgentExecutor'
import type { AgentDefinition } from 'src/types/AgentDefinition'
import type { WorkflowDefinition } from 'src/types/WorkflowDefinition'
import type { WorkflowState } from 'src/types/WorkflowState'
import { createWorkflowState } from 'src/types/WorkflowState'
import type { WorkflowManager } from 'src/workflow/WorkflowManager'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowExecutor } from '../WorkflowExecutor'

// Mock fs module
vi.mock('node:fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      stat: vi.fn(),
    },
  },
}))

// Import mocked modules
import fs from 'node:fs'

const mockReadFile = vi.mocked(fs.promises.readFile)
const mockWriteFile = vi.mocked(fs.promises.writeFile)
const mockMkdir = vi.mocked(fs.promises.mkdir)
const mockStat = vi.mocked(fs.promises.stat)

describe('WorkflowExecutor', () => {
  let executor: WorkflowExecutor
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

  const createMinimalWorkflowDefinition = (): WorkflowDefinition => ({
    name: 'test-workflow',
    version: 1,
    phases: [
      {
        id: 'planning',
        type: 'iterative',
        creator: 'plan-creator',
        reviewers: ['plan-reviewer-architecture'],
        verifiers: ['plan-verifier-architecture'],
        min_iterations: 1,
      },
    ],
    output_dir: '.cursor/agents/workflow',
  })

  const createFullWorkflowDefinition = (): WorkflowDefinition => ({
    name: 'full-workflow',
    version: 1,
    description: 'Full multi-phase workflow',
    variables: {
      output_dir: '.cursor/agents/workflow',
    },
    phases: [
      {
        id: 'planning',
        type: 'iterative',
        creator: 'plan-creator',
        reviewers: [
          'plan-reviewer-architecture',
          'plan-reviewer-integration',
          'plan-reviewer-security',
        ],
        verifiers: [
          'plan-verifier-architecture',
          'plan-verifier-integration',
          'plan-verifier-security',
        ],
        outputs: {
          artifact: '{{ output_dir }}/plans/plan-v{{ iteration }}.md',
          reviews: '{{ output_dir }}/reviews/',
        },
        min_iterations: 2,
      },
      {
        id: 'implementation',
        type: 'iterative',
        creator: 'implementer',
        reviewers: ['code-reviewer-logic', 'code-reviewer-patterns', 'code-reviewer-operations'],
        verifiers: ['code-verifier-logic', 'code-verifier-patterns', 'code-verifier-operations'],
        context: ['{{ phases.planning.outputs.artifact }}'],
        min_iterations: 1,
      },
      {
        id: 'testing-execution',
        type: 'test-execution',
        tester: 'test-writer',
        fixer: 'implementer',
        min_iterations: 1,
      },
    ],
    output_dir: '.cursor/agents/workflow',
  })

  let mockWorkflowState: WorkflowState

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

    mockWorkflowState = createWorkflowState('test-workflow', 'planning')

    mockWorkflowManager = {
      createWorkflow: vi.fn().mockResolvedValue(mockWorkflowState),
      getWorkflow: vi.fn().mockResolvedValue(mockWorkflowState),
      updateWorkflow: vi.fn().mockImplementation((_id, updates) => {
        Object.assign(mockWorkflowState, updates)
        return Promise.resolve(mockWorkflowState)
      }),
      addArtifact: vi.fn().mockResolvedValue(mockWorkflowState),
      addFeedback: vi.fn().mockResolvedValue(mockWorkflowState),
      pauseAtCheckpoint: vi.fn().mockImplementation((_id, message) => {
        mockWorkflowState.status = 'checkpoint'
        mockWorkflowState.checkpoint_message = message
        return Promise.resolve(mockWorkflowState)
      }),
      saveWorkflow: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowManager

    mockReadFile.mockResolvedValue('File content')
    mockWriteFile.mockResolvedValue(undefined)
    mockMkdir.mockResolvedValue(undefined)
    mockStat.mockResolvedValue({ isFile: () => true } as fs.Stats)

    executor = new WorkflowExecutor(mockAgentExecutor, mockAgentManager, mockWorkflowManager)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('startWorkflow', () => {
    it('should create workflow state', async () => {
      const definition = createMinimalWorkflowDefinition()

      const state = await executor.startWorkflow(definition, 'new-workflow')

      expect(mockWorkflowManager.createWorkflow).toHaveBeenCalledWith('new-workflow', 'planning')
      expect(state.workflow_id).toBe('test-workflow')
    })

    it('should throw error if definition has no phases', async () => {
      const definition: WorkflowDefinition = {
        name: 'empty',
        version: 1,
        phases: [],
      }

      await expect(executor.startWorkflow(definition, 'workflow-id')).rejects.toThrow(
        'at least one phase'
      )
    })

    it('should update workflow with input file if provided', async () => {
      const definition = createMinimalWorkflowDefinition()

      await executor.startWorkflow(definition, 'new-workflow', 'requirements.md')

      expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith('new-workflow', {
        status: 'working',
        current_artifact: 'requirements.md',
      })
    })

    it('should use first phase from definition', async () => {
      const definition = createFullWorkflowDefinition()

      await executor.startWorkflow(definition, 'workflow-id')

      expect(mockWorkflowManager.createWorkflow).toHaveBeenCalledWith('workflow-id', 'planning')
    })
  })

  describe('executeStep - iterative phase', () => {
    it('should run creator agent when status is working', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalled()
      expect(progress.step).toBe('checkpoint')
      expect(progress.message).toContain('Creator completed')
    })

    it('should run creator agent when status is idle', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'idle'

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalled()
      expect(progress.step).toBe('checkpoint')
    })

    it('should return checkpoint message when at checkpoint', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'checkpoint'
      mockWorkflowState.checkpoint_message = 'Review the plan'

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('checkpoint')
      expect(progress.message).toContain('Review the plan')
    })

    it('should run reviewers when status is reviewing', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'reviewing'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalled()
      expect(progress.step).toBe('review')
    })

    it('should run verifiers when status is verifying', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]
      mockWorkflowState.feedback_history = [
        {
          iteration: 1,
          reviewer: 'plan-reviewer-architecture',
          feedback_file: 'review-arch.md',
          addressed: false,
          created_at: new Date().toISOString(),
        },
      ]

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(mockAgentExecutor.executeAgent).toHaveBeenCalled()
      // When all verifiers pass and min_iterations is met, workflow completes
      expect(progress.step).toBe('complete')
    })

    it('should throw error if workflow not found', async () => {
      const definition = createMinimalWorkflowDefinition()
      vi.mocked(mockWorkflowManager.getWorkflow).mockResolvedValue(undefined)

      await expect(executor.executeStep(definition, 'nonexistent')).rejects.toThrow(
        'Workflow nonexistent not found'
      )
    })

    it('should throw error if phase not found', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.phase = 'nonexistent' as 'planning'

      await expect(executor.executeStep(definition, 'test-workflow')).rejects.toThrow(
        'Phase nonexistent not found'
      )
    })
  })

  describe('creator step execution', () => {
    it('should add artifact after creator completes', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'

      await executor.executeStep(definition, 'test-workflow')

      expect(mockWorkflowManager.addArtifact).toHaveBeenCalledWith(
        'test-workflow',
        expect.objectContaining({
          type: 'plan',
          created_by: 'plan-creator',
        })
      )
    })

    it('should pause at checkpoint after creator completes', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'

      await executor.executeStep(definition, 'test-workflow')

      expect(mockWorkflowManager.pauseAtCheckpoint).toHaveBeenCalled()
    })

    it('should include previous iteration feedback in creator context', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'
      mockWorkflowState.iteration = 2
      mockWorkflowState.feedback_history = [
        {
          iteration: 1,
          reviewer: 'plan-reviewer-architecture',
          feedback_file: 'reviews/plan-v1-arch.md',
          addressed: false,
          created_at: new Date().toISOString(),
        },
      ]
      mockReadFile.mockResolvedValue('Previous feedback content')

      await executor.executeStep(definition, 'test-workflow')

      expect(mockReadFile).toHaveBeenCalledWith('reviews/plan-v1-arch.md', 'utf-8')
    })

    it('should return error message if creator fails', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'
      vi.mocked(mockAgentManager.getAgent).mockResolvedValue(undefined)

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.message).toContain('failed')
    })
  })

  describe('review step execution', () => {
    it('should run all reviewers in parallel', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.status = 'reviewing'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      await executor.executeStep(definition, 'test-workflow')

      // Should execute all 3 reviewers
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalledTimes(3)
    })

    it('should add feedback for each successful review', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'reviewing'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      await executor.executeStep(definition, 'test-workflow')

      expect(mockWorkflowManager.addFeedback).toHaveBeenCalled()
    })

    it('should move to verifying status after reviews', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'reviewing'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      await executor.executeStep(definition, 'test-workflow')

      expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith('test-workflow', {
        status: 'verifying',
      })
    })

    it('should throw error if no artifact for current iteration', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'reviewing'
      mockWorkflowState.artifacts = []

      await expect(executor.executeStep(definition, 'test-workflow')).rejects.toThrow(
        'No artifact found'
      )
    })
  })

  describe('verification step execution', () => {
    it('should run verifiers with corresponding reviewer feedback', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]
      mockWorkflowState.feedback_history = [
        {
          iteration: 1,
          reviewer: 'plan-reviewer-architecture',
          feedback_file: 'review-arch.md',
          addressed: false,
          created_at: new Date().toISOString(),
        },
      ]

      await executor.executeStep(definition, 'test-workflow')

      // Should have read the feedback file
      expect(mockReadFile).toHaveBeenCalledWith('review-arch.md', 'utf-8')
    })

    it('should add verification artifact', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      await executor.executeStep(definition, 'test-workflow')

      expect(mockWorkflowManager.addArtifact).toHaveBeenCalledWith(
        'test-workflow',
        expect.objectContaining({
          type: 'verification',
        })
      )
    })

    it('should move to next phase when all verifiers pass and min_iterations met', async () => {
      const definition = createFullWorkflowDefinition()
      // Set min_iterations to 1 for testing
      ;(definition.phases[0] as { min_iterations: number }).min_iterations = 1

      mockWorkflowState.status = 'verifying'
      mockWorkflowState.iteration = 1
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('complete')
      expect(progress.message).toContain('Moving to implementation')
    })

    it('should mark workflow complete when last phase passes', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('complete')
      expect(progress.message).toContain('Workflow complete')
    })

    it('should pause at checkpoint when iteration needed', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.iteration = 1 // Less than min_iterations (2)
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'plan',
          file: 'plan-v1.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('verification')
      expect(mockWorkflowManager.pauseAtCheckpoint).toHaveBeenCalled()
    })
  })

  describe('test execution phase', () => {
    it('should run tester agent', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'working'

      await executor.executeStep(definition, 'test-workflow')

      expect(mockAgentManager.getAgent).toHaveBeenCalledWith('test-writer')
      expect(mockAgentExecutor.executeAgent).toHaveBeenCalled()
    })

    it('should add test-result artifact', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'working'

      await executor.executeStep(definition, 'test-workflow')

      expect(mockWorkflowManager.addArtifact).toHaveBeenCalledWith(
        'test-workflow',
        expect.objectContaining({
          type: 'test-result',
          created_by: 'test-writer',
        })
      )
    })

    it('should pause at checkpoint after test execution', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'working'

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('checkpoint')
      expect(mockWorkflowManager.pauseAtCheckpoint).toHaveBeenCalledWith(
        'test-workflow',
        expect.stringContaining('Test results')
      )
    })

    it('should return checkpoint message when at checkpoint', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'checkpoint'
      mockWorkflowState.checkpoint_message = 'Review test results'

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('checkpoint')
      expect(progress.message).toBe('Review test results')
    })
  })

  describe('context file resolution', () => {
    it('should resolve context files from phase definition', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'implementation'
      mockWorkflowState.status = 'working'
      mockStat.mockResolvedValue({ isFile: () => true } as fs.Stats)

      await executor.executeStep(definition, 'test-workflow')

      // Should attempt to read context files
      expect(mockStat).toHaveBeenCalled()
    })

    it('should handle missing context files gracefully', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'implementation'
      mockWorkflowState.status = 'working'
      mockStat.mockRejectedValue(new Error('ENOENT'))

      // Should not throw
      await expect(executor.executeStep(definition, 'test-workflow')).resolves.toBeDefined()
    })
  })

  describe('output path generation', () => {
    it('should use configured output directory', async () => {
      const definition = createMinimalWorkflowDefinition()
      definition.output_dir = '/custom/output'
      mockWorkflowState.status = 'working'

      await executor.executeStep(definition, 'test-workflow')

      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining('/custom/output'),
        expect.any(Object)
      )
    })

    it('should create output directories if they do not exist', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'

      await executor.executeStep(definition, 'test-workflow')

      expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true })
    })
  })

  describe('error handling', () => {
    it('should handle agent not found', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'
      vi.mocked(mockAgentManager.getAgent).mockResolvedValue(undefined)

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.message).toContain('not found')
    })

    it('should handle executor errors gracefully', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'
      vi.mocked(mockAgentExecutor.executeAgent).mockRejectedValue(new Error('Execution failed'))

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.message).toContain('failed')
    })

    it('should handle file write errors gracefully', async () => {
      const definition = createMinimalWorkflowDefinition()
      mockWorkflowState.status = 'working'
      mockWriteFile.mockRejectedValue(new Error('Write failed'))

      // Should handle gracefully (likely in runAgent)
      const progress = await executor.executeStep(definition, 'test-workflow')
      // May still complete depending on implementation
      expect(progress).toBeDefined()
    })
  })

  describe('max iterations enforcement', () => {
    it('should force phase completion when max iterations reached in iterative phase', async () => {
      const definition = createMinimalWorkflowDefinition()
      // Set max_iterations on the phase
      definition.phases[0].max_iterations = 3
      mockWorkflowState.iteration = 3
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [
        {
          iteration: 3,
          type: 'plan',
          file: 'plan-v3.md',
          created_by: 'plan-creator',
          created_at: new Date().toISOString(),
        },
      ]
      mockWorkflowState.feedback_history = [
        {
          iteration: 3,
          reviewer: 'plan-reviewer-architecture',
          feedback_file: 'review-arch.md',
          addressed: false,
          created_at: new Date().toISOString(),
        },
      ]

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('complete')
      expect(progress.message).toContain('max iterations')
    })

    it('should complete workflow when max iterations reached in test-execution phase', async () => {
      const definition = createFullWorkflowDefinition()
      // Set max_iterations on test-execution phase
      const testExecutionPhase = definition.phases.find((p) => p.id === 'testing-execution')
      if (testExecutionPhase) {
        testExecutionPhase.max_iterations = 2
      }
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.iteration = 2
      mockWorkflowState.status = 'working'

      const progress = await executor.executeStep(definition, 'test-workflow')

      expect(progress.step).toBe('complete')
      expect(progress.message).toContain('max')
      expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith(
        'test-workflow',
        expect.objectContaining({ status: 'complete' })
      )
    })
  })

  describe('fixer agent in test-execution phase', () => {
    it('should run fixer agent when status is verifying in test-execution', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'test-result',
          file: 'test-results/run-1.md',
          created_by: 'test-writer',
          created_at: new Date().toISOString(),
        },
      ]

      await executor.executeStep(definition, 'test-workflow')

      // Should call fixer agent (implementer in full workflow definition)
      expect(mockAgentManager.getAgent).toHaveBeenCalledWith('implementer')
    })

    it('should throw error when no test results available for fixer', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [] // No test results

      await expect(executor.executeStep(definition, 'test-workflow')).rejects.toThrow(
        'No test results found'
      )
    })

    it('should increment iteration after fixer completes', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.iteration = 1
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'test-result',
          file: 'test-results/run-1.md',
          created_by: 'test-writer',
          created_at: new Date().toISOString(),
        },
      ]

      await executor.executeStep(definition, 'test-workflow')

      expect(mockWorkflowManager.updateWorkflow).toHaveBeenCalledWith(
        'test-workflow',
        expect.objectContaining({
          iteration: 2,
          status: 'working',
        })
      )
    })

    it('should handle fixer agent failure gracefully', async () => {
      const definition = createFullWorkflowDefinition()
      mockWorkflowState.phase = 'testing-execution'
      mockWorkflowState.status = 'verifying'
      mockWorkflowState.artifacts = [
        {
          iteration: 1,
          type: 'test-result',
          file: 'test-results/run-1.md',
          created_by: 'test-writer',
          created_at: new Date().toISOString(),
        },
      ]
      vi.mocked(mockAgentExecutor.executeAgent).mockRejectedValue(new Error('Fixer failed'))

      const progress = await executor.executeStep(definition, 'test-workflow')

      // Should pause at checkpoint with error message
      expect(mockWorkflowManager.pauseAtCheckpoint).toHaveBeenCalledWith(
        'test-workflow',
        expect.stringContaining('failed')
      )
    })
  })
})
