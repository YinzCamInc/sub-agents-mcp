/**
 * Tests for OutputValidator utilities
 */

import { describe, expect, it } from 'vitest'
import {
  OutputValidator,
  extractJson,
  parseMarkdownSections,
  parseVerificationOutput,
  validateSchema,
} from '../OutputValidator'

describe('OutputValidator', () => {
  describe('extractJson', () => {
    it('should extract pure JSON object', () => {
      const json = extractJson('{"key": "value"}')
      expect(json).toEqual({ key: 'value' })
    })

    it('should extract pure JSON array', () => {
      const json = extractJson('[1, 2, 3]')
      expect(json).toEqual([1, 2, 3])
    })

    it('should extract JSON from markdown code block', () => {
      const text = `
Here is the result:

\`\`\`json
{"status": "success"}
\`\`\`
`
      const json = extractJson(text)
      expect(json).toEqual({ status: 'success' })
    })

    it('should extract JSON from unmarked code block', () => {
      const text = `
Result:

\`\`\`
{"name": "test"}
\`\`\`
`
      const json = extractJson(text)
      expect(json).toEqual({ name: 'test' })
    })

    it('should extract embedded JSON from text', () => {
      const text = 'The result is {"found": true} which indicates success.'
      const json = extractJson(text)
      expect(json).toEqual({ found: true })
    })

    it('should return null for invalid JSON', () => {
      const json = extractJson('This is just text with no JSON')
      expect(json).toBeNull()
    })

    it('should handle whitespace', () => {
      const json = extractJson('  \n  {"padded": true}  \n  ')
      expect(json).toEqual({ padded: true })
    })
  })

  describe('validateSchema', () => {
    it('should validate simple object', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          age: { type: 'number' as const },
        },
        required: ['name'],
      }

      const result = validateSchema({ name: 'John', age: 30 }, schema)
      expect(result.valid).toBe(true)
      expect(result.data).toEqual({ name: 'John', age: 30 })
    })

    it('should fail on missing required field', () => {
      const schema = {
        type: 'object' as const,
        required: ['name'],
      }

      const result = validateSchema({}, schema)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing required field: name')
    })

    it('should fail on wrong type', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          count: { type: 'number' as const },
        },
      }

      const result = validateSchema({ count: 'not a number' }, schema)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('Expected number')
    })

    it('should validate arrays', () => {
      const schema = {
        type: 'array' as const,
        items: { type: 'string' as const },
      }

      const result = validateSchema(['a', 'b', 'c'], schema)
      expect(result.valid).toBe(true)
    })

    it('should fail on array with wrong item type', () => {
      const schema = {
        type: 'array' as const,
        items: { type: 'number' as const },
      }

      const result = validateSchema([1, 'two', 3], schema)
      expect(result.valid).toBe(false)
    })

    it('should validate nested objects', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          user: {
            type: 'object' as const,
            properties: {
              name: { type: 'string' as const },
            },
          },
        },
      }

      const result = validateSchema({ user: { name: 'John' } }, schema)
      expect(result.valid).toBe(true)
    })
  })

  describe('parseMarkdownSections', () => {
    it('should parse simple sections', () => {
      const markdown = `# Header 1
Content 1

## Header 2
Content 2
`
      const sections = parseMarkdownSections(markdown)

      expect(sections).toHaveLength(2)
      expect(sections[0].heading).toBe('Header 1')
      expect(sections[0].level).toBe(1)
      expect(sections[0].content).toBe('Content 1')
      expect(sections[1].heading).toBe('Header 2')
      expect(sections[1].level).toBe(2)
    })

    it('should handle multiple heading levels', () => {
      const markdown = `### Level 3
Content

###### Level 6
More content
`
      const sections = parseMarkdownSections(markdown)

      expect(sections[0].level).toBe(3)
      expect(sections[1].level).toBe(6)
    })

    it('should handle multiline content', () => {
      const markdown = `# Title

Line 1
Line 2
Line 3
`
      const sections = parseMarkdownSections(markdown)

      expect(sections[0].content).toContain('Line 1')
      expect(sections[0].content).toContain('Line 2')
      expect(sections[0].content).toContain('Line 3')
    })
  })

  describe('parseVerificationOutput', () => {
    it('should detect APPROVE recommendation', () => {
      const output = 'Recommendation: APPROVE\nAll checks passed.'
      const result = parseVerificationOutput(output)

      expect(result.recommendation).toBe('APPROVE')
      expect(result.passed).toBe(true)
    })

    it('should detect ITERATE recommendation', () => {
      const output = 'Verdict: iterate\nSome issues need addressing.'
      const result = parseVerificationOutput(output)

      expect(result.recommendation).toBe('ITERATE')
      expect(result.passed).toBe(false)
    })

    it('should detect REJECT recommendation', () => {
      const output = 'Decision: REJECT\nFailed validation.'
      const result = parseVerificationOutput(output)

      expect(result.recommendation).toBe('REJECT')
      expect(result.passed).toBe(false)
    })

    it('should count critical issues', () => {
      const output = `Critical: 2
Major issues found.
- [critical] Security vulnerability
- [critical] Data leak
`
      const result = parseVerificationOutput(output)

      expect(result.criticalCount).toBeGreaterThanOrEqual(2)
    })

    it('should extract issues from list', () => {
      const output = `Issues:
- [major] Missing error handling
- [minor] Code style issue
- [info] Consider refactoring
`
      const result = parseVerificationOutput(output)

      expect(result.issues.length).toBeGreaterThanOrEqual(3)
    })

    it('should pass when all checks pass', () => {
      const output = 'All checks passed! Approved.'
      const result = parseVerificationOutput(output)

      expect(result.passed).toBe(true)
    })

    it('should fail when issues found', () => {
      const output = 'Issues found. Changes required.'
      const result = parseVerificationOutput(output)

      expect(result.passed).toBe(false)
    })
  })

  describe('OutputValidator class', () => {
    const validator = new OutputValidator()

    describe('extractAndValidateJson', () => {
      it('should extract and validate JSON', () => {
        const schema = {
          type: 'object' as const,
          properties: {
            status: { type: 'string' as const },
          },
        }

        const result = validator.extractAndValidateJson('{"status": "ok"}', schema)

        expect(result.valid).toBe(true)
        expect(result.data).toEqual({ status: 'ok' })
      })

      it('should return error for no JSON', () => {
        const result = validator.extractAndValidateJson('No JSON here')

        expect(result.valid).toBe(false)
        expect(result.errors[0]).toContain('No valid JSON')
      })
    })

    describe('findSection', () => {
      it('should find section by heading', () => {
        const markdown = `# Introduction
Intro content

# Summary
Summary content
`
        const content = validator.findSection(markdown, 'Summary')
        expect(content).toBe('Summary content')
      })

      it('should be case-insensitive', () => {
        const markdown = `# SUMMARY
Content here
`
        const content = validator.findSection(markdown, 'summary')
        expect(content).toBe('Content here')
      })

      it('should return undefined for missing section', () => {
        const markdown = '# Other\nContent'
        const content = validator.findSection(markdown, 'Missing')
        expect(content).toBeUndefined()
      })
    })

    describe('formatErrors', () => {
      it('should format passing result', () => {
        const result = {
          valid: true,
          errors: [],
          warnings: [],
        }

        const formatted = validator.formatErrors(result)
        expect(formatted).toContain('✅')
      })

      it('should format errors', () => {
        const result = {
          valid: false,
          errors: ['Error 1', 'Error 2'],
          warnings: [],
        }

        const formatted = validator.formatErrors(result)
        expect(formatted).toContain('❌')
        expect(formatted).toContain('Error 1')
        expect(formatted).toContain('Error 2')
      })

      it('should include warnings', () => {
        const result = {
          valid: false,
          errors: ['Error'],
          warnings: ['Warning'],
        }

        const formatted = validator.formatErrors(result)
        expect(formatted).toContain('⚠️')
        expect(formatted).toContain('Warning')
      })
    })
  })
})
