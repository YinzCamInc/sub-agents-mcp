/**
 * TokenBudget - Utilities for estimating token usage and enforcing limits.
 *
 * Provides:
 * - Token estimation from text
 * - Model-specific token limits
 * - Context budget warnings and validation
 */

import type { AgentModelId } from 'src/types/AgentDefinition'
import { Logger } from './Logger'

/**
 * Token limits by model.
 * These are approximate limits; actual limits may vary.
 */
export const MODEL_TOKEN_LIMITS: Record<AgentModelId | string, number> = {
  // Claude models
  'claude-opus-4-5': 200000,
  'claude-sonnet-4-5': 200000,

  // GPT models
  'gpt-5-2-codex': 128000,

  // Default for unknown models
  default: 100000,
}

/**
 * Threshold percentages for warnings and errors.
 */
export const TOKEN_THRESHOLDS = {
  /** Warning threshold as percentage of limit */
  WARNING: 0.8,
  /** Error threshold as percentage of limit */
  ERROR: 0.95,
  /** Target threshold for context budget planning */
  TARGET: 0.7,
}

/**
 * Result of a token estimation.
 */
export interface TokenEstimate {
  /** Estimated number of tokens */
  tokens: number
  /** Character count */
  characters: number
  /** Percentage of model limit */
  percentage: number
  /** The model used for limit calculation */
  model: string
  /** The model's token limit */
  limit: number
  /** Whether this exceeds the warning threshold */
  exceedsWarning: boolean
  /** Whether this exceeds the error threshold */
  exceedsError: boolean
}

/**
 * Token budget validation result.
 */
export interface TokenBudgetValidation {
  /** Whether the content is within budget */
  valid: boolean
  /** The token estimate */
  estimate: TokenEstimate
  /** Warning message if approaching limit */
  warning?: string | undefined
  /** Error message if over limit */
  error?: string | undefined
  /** Recommended action if over budget */
  recommendation?: string | undefined
}

/**
 * Estimates tokens from text.
 *
 * Uses a simple heuristic: ~4 characters per token.
 * This is a rough approximation; actual tokenization varies by model.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  // Rough heuristic: ~4 characters per token
  // This is a simplified estimation that works reasonably well for English text
  return Math.ceil(text.length / 4)
}

/**
 * Get the token limit for a model.
 *
 * @param model - The model ID
 * @returns Token limit for the model
 */
export function getModelLimit(model: string | undefined): number {
  const defaultLimit = MODEL_TOKEN_LIMITS['default'] as number
  if (!model) {
    return defaultLimit
  }
  return MODEL_TOKEN_LIMITS[model as AgentModelId] ?? defaultLimit
}

/**
 * Estimate tokens for content with model-specific context.
 *
 * @param text - The text to estimate
 * @param model - The model to check limits against
 * @returns Token estimate with model context
 */
export function estimateTokensForModel(text: string, model: string | undefined): TokenEstimate {
  const tokens = estimateTokens(text)
  const limit = getModelLimit(model)
  const percentage = tokens / limit

  return {
    tokens,
    characters: text.length,
    percentage,
    model: model || 'default',
    limit,
    exceedsWarning: percentage > TOKEN_THRESHOLDS.WARNING,
    exceedsError: percentage > TOKEN_THRESHOLDS.ERROR,
  }
}

/**
 * Validate content against token budget.
 *
 * @param text - The text to validate
 * @param model - The model to check limits against
 * @returns Validation result with warnings/errors
 */
export function validateTokenBudget(
  text: string,
  model: string | undefined
): TokenBudgetValidation {
  const estimate = estimateTokensForModel(text, model)

  const result: TokenBudgetValidation = {
    valid: !estimate.exceedsError,
    estimate,
  }

  if (estimate.exceedsError) {
    result.error =
      `Context is ~${estimate.tokens.toLocaleString()} tokens ` +
      `(${Math.round(estimate.percentage * 100)}% of ${estimate.model} limit: ` +
      `${estimate.limit.toLocaleString()}). This exceeds the safe limit.`

    result.recommendation =
      'Consider: (1) Reducing context files, (2) Summarizing large files, ' +
      '(3) Using a model with higher token limit, or (4) Splitting the task.'
  } else if (estimate.exceedsWarning) {
    result.warning = `⚠️ Context is ~${estimate.tokens.toLocaleString()} tokens (${Math.round(estimate.percentage * 100)}% of ${estimate.model} limit). Consider reducing context to avoid issues.`
  }

  return result
}

/**
 * TokenBudgetChecker class for managing token budgets across operations.
 */
export class TokenBudgetChecker {
  private readonly logger: Logger
  private readonly defaultModel: string

  constructor(defaultModel?: string) {
    this.logger = new Logger('debug')
    this.defaultModel = defaultModel || 'claude-sonnet-4-5'
  }

  /**
   * Check content against token budget and log warnings.
   *
   * @param content - The content to check
   * @param model - Optional model override
   * @param context - Additional context for logging
   * @returns Validation result
   */
  check(content: string, model?: string, context?: Record<string, unknown>): TokenBudgetValidation {
    const result = validateTokenBudget(content, model || this.defaultModel)

    if (result.error) {
      this.logger.error('Token budget exceeded', undefined, {
        ...context,
        tokens: result.estimate.tokens,
        limit: result.estimate.limit,
        percentage: `${Math.round(result.estimate.percentage * 100)}%`,
        model: result.estimate.model,
      })
    } else if (result.warning) {
      this.logger.warn(result.warning, {
        ...context,
        tokens: result.estimate.tokens,
        limit: result.estimate.limit,
        percentage: `${Math.round(result.estimate.percentage * 100)}%`,
        model: result.estimate.model,
      })
    } else {
      this.logger.debug('Token budget check passed', {
        ...context,
        tokens: result.estimate.tokens,
        percentage: `${Math.round(result.estimate.percentage * 100)}%`,
      })
    }

    return result
  }

  /**
   * Check and throw if over budget.
   *
   * @param content - The content to check
   * @param model - Optional model override
   * @param context - Additional context for error message
   * @throws Error if content exceeds error threshold
   */
  checkOrThrow(
    content: string,
    model?: string,
    context?: Record<string, unknown>
  ): TokenBudgetValidation {
    const result = this.check(content, model, context)

    if (!result.valid && result.error) {
      const errorMsg = result.recommendation
        ? `${result.error}\n\n${result.recommendation}`
        : result.error
      throw new Error(errorMsg)
    }

    return result
  }

  /**
   * Calculate remaining budget.
   *
   * @param currentContent - Current content size
   * @param model - Model to check against
   * @returns Remaining tokens available
   */
  getRemainingBudget(currentContent: string, model?: string): number {
    const estimate = estimateTokensForModel(currentContent, model || this.defaultModel)
    const targetLimit = Math.floor(estimate.limit * TOKEN_THRESHOLDS.TARGET)
    return Math.max(0, targetLimit - estimate.tokens)
  }

  /**
   * Format a budget summary for display.
   *
   * @param content - The content to summarize
   * @param model - Model to check against
   * @returns Formatted budget summary string
   */
  formatBudgetSummary(content: string, model?: string): string {
    const estimate = estimateTokensForModel(content, model || this.defaultModel)

    const status = estimate.exceedsError
      ? '❌ OVER LIMIT'
      : estimate.exceedsWarning
        ? '⚠️ WARNING'
        : '✅ OK'

    return (
      `Token Budget: ${status}\n` +
      `  Estimated: ~${estimate.tokens.toLocaleString()} tokens\n` +
      `  Model: ${estimate.model} (limit: ${estimate.limit.toLocaleString()})\n` +
      `  Usage: ${Math.round(estimate.percentage * 100)}%`
    )
  }
}
