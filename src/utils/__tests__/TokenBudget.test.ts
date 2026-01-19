/**
 * Tests for TokenBudget utilities
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_TOKEN_LIMITS,
  TOKEN_THRESHOLDS,
  TokenBudgetChecker,
  estimateTokens,
  estimateTokensForModel,
  getModelLimit,
  validateTokenBudget,
} from '../TokenBudget'

describe('TokenBudget', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens at ~4 chars per token', () => {
      const text = 'a'.repeat(100)
      expect(estimateTokens(text)).toBe(25) // 100 / 4 = 25
    })

    it('should round up for partial tokens', () => {
      const text = 'a'.repeat(101)
      expect(estimateTokens(text)).toBe(26) // ceil(101 / 4) = 26
    })

    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0)
    })
  })

  describe('getModelLimit', () => {
    it('should return limit for claude-opus-4-5', () => {
      expect(getModelLimit('claude-opus-4-5')).toBe(200000)
    })

    it('should return limit for claude-sonnet-4-5', () => {
      expect(getModelLimit('claude-sonnet-4-5')).toBe(200000)
    })

    it('should return limit for gpt-5-2-codex', () => {
      expect(getModelLimit('gpt-5-2-codex')).toBe(128000)
    })

    it('should return default limit for unknown model', () => {
      expect(getModelLimit('unknown-model')).toBe(100000)
    })

    it('should return default limit for undefined', () => {
      expect(getModelLimit(undefined)).toBe(100000)
    })
  })

  describe('estimateTokensForModel', () => {
    it('should calculate percentage of limit', () => {
      const text = 'a'.repeat(40000) // ~10K tokens
      const estimate = estimateTokensForModel(text, 'claude-opus-4-5')

      expect(estimate.tokens).toBe(10000)
      expect(estimate.characters).toBe(40000)
      expect(estimate.limit).toBe(200000)
      expect(estimate.percentage).toBeCloseTo(0.05, 2) // 10K / 200K = 5%
      expect(estimate.exceedsWarning).toBe(false)
      expect(estimate.exceedsError).toBe(false)
    })

    it('should flag warning threshold', () => {
      // Create text that is 85% of limit
      const limit = 200000
      const targetTokens = Math.ceil(limit * 0.85)
      const text = 'a'.repeat(targetTokens * 4)
      const estimate = estimateTokensForModel(text, 'claude-opus-4-5')

      expect(estimate.exceedsWarning).toBe(true)
      expect(estimate.exceedsError).toBe(false)
    })

    it('should flag error threshold', () => {
      // Create text that is 96% of limit
      const limit = 200000
      const targetTokens = Math.ceil(limit * 0.96)
      const text = 'a'.repeat(targetTokens * 4)
      const estimate = estimateTokensForModel(text, 'claude-opus-4-5')

      expect(estimate.exceedsWarning).toBe(true)
      expect(estimate.exceedsError).toBe(true)
    })
  })

  describe('validateTokenBudget', () => {
    it('should return valid for small content', () => {
      const result = validateTokenBudget('Hello world', 'claude-opus-4-5')

      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.warning).toBeUndefined()
    })

    it('should return warning for large content', () => {
      const limit = 200000
      const targetTokens = Math.ceil(limit * 0.85)
      const text = 'a'.repeat(targetTokens * 4)
      const result = validateTokenBudget(text, 'claude-opus-4-5')

      expect(result.valid).toBe(true)
      expect(result.warning).toBeDefined()
      expect(result.warning).toContain('⚠️')
      expect(result.error).toBeUndefined()
    })

    it('should return error for oversized content', () => {
      const limit = 200000
      const targetTokens = Math.ceil(limit * 0.96)
      const text = 'a'.repeat(targetTokens * 4)
      const result = validateTokenBudget(text, 'claude-opus-4-5')

      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.recommendation).toBeDefined()
    })
  })

  describe('TokenBudgetChecker', () => {
    let checker: TokenBudgetChecker

    beforeEach(() => {
      checker = new TokenBudgetChecker('claude-sonnet-4-5')
    })

    describe('check', () => {
      it('should pass for small content', () => {
        const result = checker.check('Hello world')

        expect(result.valid).toBe(true)
      })

      it('should use model override', () => {
        const result = checker.check('test', 'gpt-5-2-codex')

        expect(result.estimate.model).toBe('gpt-5-2-codex')
        expect(result.estimate.limit).toBe(128000)
      })
    })

    describe('checkOrThrow', () => {
      it('should not throw for valid content', () => {
        expect(() => checker.checkOrThrow('Hello world')).not.toThrow()
      })

      it('should throw for oversized content', () => {
        const limit = 200000
        const targetTokens = Math.ceil(limit * 0.96)
        const text = 'a'.repeat(targetTokens * 4)

        expect(() => checker.checkOrThrow(text)).toThrow()
      })
    })

    describe('getRemainingBudget', () => {
      it('should calculate remaining tokens', () => {
        const remaining = checker.getRemainingBudget('Hello world')

        // Target is 70% of limit (140K for claude-sonnet)
        // Small content uses almost nothing
        expect(remaining).toBeGreaterThan(100000)
      })

      it('should return 0 when over budget', () => {
        const limit = 200000
        const targetTokens = Math.ceil(limit * 0.8)
        const text = 'a'.repeat(targetTokens * 4)

        const remaining = checker.getRemainingBudget(text)
        expect(remaining).toBe(0)
      })
    })

    describe('formatBudgetSummary', () => {
      it('should format OK summary', () => {
        const summary = checker.formatBudgetSummary('Hello world')

        expect(summary).toContain('✅ OK')
        expect(summary).toContain('claude-sonnet-4-5')
      })

      it('should format WARNING summary', () => {
        const limit = 200000
        const targetTokens = Math.ceil(limit * 0.85)
        const text = 'a'.repeat(targetTokens * 4)

        const summary = checker.formatBudgetSummary(text)
        expect(summary).toContain('⚠️ WARNING')
      })

      it('should format OVER LIMIT summary', () => {
        const limit = 200000
        const targetTokens = Math.ceil(limit * 0.96)
        const text = 'a'.repeat(targetTokens * 4)

        const summary = checker.formatBudgetSummary(text)
        expect(summary).toContain('❌ OVER LIMIT')
      })
    })
  })
})
