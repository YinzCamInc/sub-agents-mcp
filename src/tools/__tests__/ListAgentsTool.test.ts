import type { AgentManager } from 'src/agents/AgentManager'
import { ListAgentsTool } from 'src/tools/ListAgentsTool'
import type { AgentDefinition } from 'src/types/AgentDefinition'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('ListAgentsTool', () => {
  let listAgentsTool: ListAgentsTool
  let mockAgentManager: AgentManager

  const mockAgents: AgentDefinition[] = [
    {
      name: 'plan-creator',
      description: 'Creates detailed implementation plans',
      content: '# Plan Creator\nCreates plans...',
      filePath: '/agents/plan-creator.md',
      lastModified: new Date('2025-01-01'),
      model: 'claude-opus-4-5',
    },
    {
      name: 'code-reviewer',
      description: 'Reviews code for quality',
      content: '# Code Reviewer\nReviews code...',
      filePath: '/agents/code-reviewer.md',
      lastModified: new Date('2025-01-01'),
      model: 'claude-sonnet-4-5',
    },
    {
      name: 'security-reviewer',
      description: 'Reviews code for security issues',
      content: '# Security Reviewer\nChecks security...',
      filePath: '/agents/security-reviewer.md',
      lastModified: new Date('2025-01-01'),
      model: 'gpt-5-2-codex',
    },
  ]

  beforeEach(() => {
    mockAgentManager = {
      listAgents: vi.fn().mockResolvedValue(mockAgents),
      getAgent: vi.fn(),
      refreshAgents: vi.fn(),
    } as unknown as AgentManager

    listAgentsTool = new ListAgentsTool(mockAgentManager)
  })

  describe('Tool Properties', () => {
    it('should have correct name', () => {
      expect(listAgentsTool.name).toBe('list_agents')
    })

    it('should have a description', () => {
      expect(listAgentsTool.description).toBeDefined()
      expect(listAgentsTool.description.length).toBeGreaterThan(0)
    })

    it('should have correct input schema', () => {
      expect(listAgentsTool.inputSchema.type).toBe('object')
      expect(listAgentsTool.inputSchema.properties).toBeDefined()
      expect(listAgentsTool.inputSchema.properties['filter']).toBeDefined()
      expect(listAgentsTool.inputSchema.required).toEqual([])
    })
  })

  describe('execute', () => {
    it('should return all agents when no filter provided', async () => {
      // Act
      const result = await listAgentsTool.execute({})

      // Assert
      expect(result.isError).toBeUndefined()
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')

      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.agents).toHaveLength(3)
      expect(responseData.total).toBe(3)
      expect(responseData.filter).toBeNull()
    })

    it('should return all agents when params is undefined', async () => {
      // Act
      const result = await listAgentsTool.execute(undefined)

      // Assert
      expect(result.isError).toBeUndefined()
      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.agents).toHaveLength(3)
    })

    it('should return all agents when params is null', async () => {
      // Act
      const result = await listAgentsTool.execute(null)

      // Assert
      expect(result.isError).toBeUndefined()
      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.agents).toHaveLength(3)
    })

    it('should filter agents by name', async () => {
      // Act
      const result = await listAgentsTool.execute({ filter: 'plan' })

      // Assert
      expect(result.isError).toBeUndefined()
      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.agents).toHaveLength(1)
      expect(responseData.agents[0].name).toBe('plan-creator')
      expect(responseData.filter).toBe('plan')
    })

    it('should filter agents by description', async () => {
      // Act
      const result = await listAgentsTool.execute({ filter: 'security' })

      // Assert
      expect(result.isError).toBeUndefined()
      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.agents).toHaveLength(1)
      expect(responseData.agents[0].name).toBe('security-reviewer')
    })

    it('should filter case-insensitively', async () => {
      // Act
      const result = await listAgentsTool.execute({ filter: 'REVIEWER' })

      // Assert
      expect(result.isError).toBeUndefined()
      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.agents).toHaveLength(2)
      expect(responseData.agents.map((a: { name: string }) => a.name)).toContain('code-reviewer')
      expect(responseData.agents.map((a: { name: string }) => a.name)).toContain(
        'security-reviewer'
      )
    })

    it('should return empty array when no agents match filter', async () => {
      // Act
      const result = await listAgentsTool.execute({ filter: 'nonexistent' })

      // Assert
      expect(result.isError).toBeUndefined()
      const responseData = JSON.parse(result.content[0].text)
      expect(responseData.agents).toHaveLength(0)
      expect(responseData.total).toBe(0)
    })

    it('should include model in agent summary', async () => {
      // Act
      const result = await listAgentsTool.execute({})

      // Assert
      const responseData = JSON.parse(result.content[0].text)
      const planCreator = responseData.agents.find(
        (a: { name: string }) => a.name === 'plan-creator'
      )
      expect(planCreator.model).toBe('claude-opus-4-5')

      const codeReviewer = responseData.agents.find(
        (a: { name: string }) => a.name === 'code-reviewer'
      )
      expect(codeReviewer.model).toBe('claude-sonnet-4-5')

      const securityReviewer = responseData.agents.find(
        (a: { name: string }) => a.name === 'security-reviewer'
      )
      expect(securityReviewer.model).toBe('gpt-5-2-codex')
    })

    it('should sort agents by name', async () => {
      // Act
      const result = await listAgentsTool.execute({})

      // Assert
      const responseData = JSON.parse(result.content[0].text)
      const names = responseData.agents.map((a: { name: string }) => a.name)
      expect(names).toEqual(['code-reviewer', 'plan-creator', 'security-reviewer'])
    })

    it('should include structuredContent in response', async () => {
      // Act
      const result = await listAgentsTool.execute({})

      // Assert
      expect(result.structuredContent).toBeDefined()
      expect((result.structuredContent as { agents: unknown[] }).agents).toHaveLength(3)
    })
  })

  describe('Parameter Validation', () => {
    it('should reject filter longer than 200 characters', async () => {
      // Arrange
      const longFilter = 'a'.repeat(201)

      // Act
      const result = await listAgentsTool.execute({ filter: longFilter })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('max 200 characters')
    })

    it('should reject non-string filter', async () => {
      // Act
      const result = await listAgentsTool.execute({ filter: 123 })

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toContain('string')
    })
  })

  describe('Error Handling', () => {
    it('should handle AgentManager errors gracefully', async () => {
      // Arrange
      vi.mocked(mockAgentManager.listAgents).mockRejectedValue(new Error('Database error'))

      // Act
      const result = await listAgentsTool.execute({})

      // Assert
      expect(result.isError).toBe(true)
      const errorData = JSON.parse(result.content[0].text)
      expect(errorData.error).toBe('Database error')
      expect(errorData.status).toBe('error')
    })
  })
})
