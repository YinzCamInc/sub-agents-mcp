/**
 * Supported model identifiers for agent execution.
 * Maps to actual model names in the MODEL_MAP.
 *
 * Current models (as of Jan 2026):
 * - Opus 4.5: Strongest reasoning, long-context, business-critical tasks
 * - Sonnet 4.5: Balanced cost/performance, strong for code and multi-hour agent tasks
 * - GPT-5.2 Codex: Best for agentic coding, large refactors, long horizon tasks
 */
export type AgentModelId = 'claude-opus-4-5' | 'claude-sonnet-4-5' | 'gpt-5-2-codex'

/**
 * Model mapping from agent model IDs to actual API model names.
 */
export const MODEL_MAP: Record<AgentModelId, string> = {
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'gpt-5-2-codex': 'gpt-5.2-codex',
}

/**
 * Default model to use when not specified in frontmatter.
 */
export const DEFAULT_MODEL: AgentModelId = 'claude-sonnet-4-5'

/**
 * Represents an AI agent definition loaded from a markdown file.
 * This interface defines the structure for Claude Code sub-agent format files
 * that contain agent instructions and metadata.
 */
export interface AgentDefinition {
  /**
   * The unique name identifier of the agent.
   * Used as the key for agent selection and execution.
   */
  name: string

  /**
   * Human-readable description of what the agent does.
   * Provides context about the agent's purpose and capabilities.
   */
  description: string

  /**
   * The full content/instructions for the agent (without frontmatter).
   * Contains the markdown content with agent directives and examples.
   */
  content: string

  /**
   * Absolute file path where the agent definition is stored.
   * Used for file watching and cache invalidation.
   */
  filePath: string

  /**
   * Timestamp when the agent definition file was last modified.
   * Used for cache invalidation and version tracking.
   */
  lastModified: Date

  /**
   * The model to use for this agent, parsed from frontmatter.
   * If not specified in frontmatter, defaults to 'claude-sonnet-4'.
   */
  model: AgentModelId

  /**
   * Raw frontmatter data from the agent definition file.
   * Contains any additional metadata defined in the YAML frontmatter.
   */
  frontmatter?: Record<string, unknown>
}
