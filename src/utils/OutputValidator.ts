/**
 * OutputValidator - Utilities for validating and parsing agent outputs.
 *
 * Provides:
 * - JSON extraction from agent responses
 * - Schema validation for structured outputs
 * - Markdown section parsing
 * - Verification result parsing
 */

import { Logger } from './Logger'

/**
 * Schema for a field in structured output.
 */
export interface FieldSchema {
  /** Field type */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  /** Whether the field is required */
  required?: boolean
  /** Description for error messages */
  description?: string
  /** Nested schema for array items or object properties */
  items?: FieldSchema
  /** Properties for object type */
  properties?: Record<string, FieldSchema>
}

/**
 * Schema for structured output validation.
 */
export interface OutputSchema {
  /** Type of the root value */
  type: 'object' | 'array'
  /** Properties for object type */
  properties?: Record<string, FieldSchema>
  /** Schema for array items */
  items?: FieldSchema
  /** Required fields */
  required?: string[]
}

/**
 * Result of output validation.
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean
  /** Parsed data if successful */
  data?: unknown
  /** Validation errors */
  errors: string[]
  /** Warnings (non-blocking issues) */
  warnings: string[]
}

/**
 * Parsed verification result from verifier agents.
 */
export interface VerificationResult {
  /** Whether verification passed */
  passed: boolean
  /** Recommendation (APPROVE, ITERATE, etc.) */
  recommendation?: string | undefined
  /** Number of issues found */
  issueCount: number
  /** Number of critical issues */
  criticalCount: number
  /** List of issues */
  issues: Array<{
    severity: 'critical' | 'major' | 'minor' | 'info'
    description: string
  }>
  /** Raw feedback text */
  feedback: string
}

/**
 * Parsed markdown section.
 */
export interface MarkdownSection {
  /** Section heading */
  heading: string
  /** Heading level (1-6) */
  level: number
  /** Section content */
  content: string
}

/**
 * Extract JSON from agent output.
 *
 * Handles:
 * - Pure JSON responses
 * - JSON embedded in markdown code blocks
 * - JSON after text content
 *
 * @param output - Agent output text
 * @returns Extracted JSON object or null
 */
export function extractJson(output: string): unknown {
  // Try pure JSON first
  const trimmed = output.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Continue to other extraction methods
    }
  }

  // Try JSON in code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim())
    } catch {
      // Continue
    }
  }

  // Try finding JSON object/array in text
  const jsonMatch = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(jsonMatch[1])
    } catch {
      // Return null if no valid JSON found
    }
  }

  return null
}

/**
 * Validate data against a schema.
 *
 * @param data - Data to validate
 * @param schema - Schema to validate against
 * @returns Validation result
 */
export function validateSchema(data: unknown, schema: OutputSchema): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push('Expected an object')
      return { valid: false, errors, warnings }
    }

    const obj = data as Record<string, unknown>

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in obj)) {
          errors.push(`Missing required field: ${field}`)
        }
      }
    }

    // Validate properties
    if (schema.properties) {
      for (const [key, fieldSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const fieldResult = validateField(obj[key], fieldSchema, key)
          errors.push(...fieldResult.errors)
          warnings.push(...fieldResult.warnings)
        } else if (fieldSchema.required) {
          errors.push(`Missing required field: ${key}`)
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(data)) {
      errors.push('Expected an array')
      return { valid: false, errors, warnings }
    }

    if (schema.items) {
      for (const [index, item] of data.entries()) {
        const itemResult = validateField(item, schema.items, `[${index}]`)
        errors.push(...itemResult.errors)
        warnings.push(...itemResult.warnings)
      }
    }
  }

  return {
    valid: errors.length === 0,
    data: errors.length === 0 ? data : undefined,
    errors,
    warnings,
  }
}

/**
 * Validate a single field against its schema.
 */
function validateField(
  value: unknown,
  schema: FieldSchema,
  path: string
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  // Type check
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${path}: Expected string, got ${typeof value}`)
      }
      break
    case 'number':
      if (typeof value !== 'number') {
        errors.push(`${path}: Expected number, got ${typeof value}`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${path}: Expected boolean, got ${typeof value}`)
      }
      break
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${path}: Expected array, got ${typeof value}`)
      } else if (schema.items) {
        for (const [index, item] of value.entries()) {
          const itemResult = validateField(item, schema.items, `${path}[${index}]`)
          errors.push(...itemResult.errors)
          warnings.push(...itemResult.warnings)
        }
      }
      break
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path}: Expected object, got ${typeof value}`)
      } else if (schema.properties) {
        const obj = value as Record<string, unknown>
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          if (key in obj) {
            const propResult = validateField(obj[key], propSchema, `${path}.${key}`)
            errors.push(...propResult.errors)
            warnings.push(...propResult.warnings)
          } else if (propSchema.required) {
            errors.push(`${path}.${key}: Missing required field`)
          }
        }
      }
      break
  }

  return { errors, warnings }
}

/**
 * Parse markdown into sections by headings.
 *
 * @param markdown - Markdown text to parse
 * @returns Array of parsed sections
 */
export function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  const lines = markdown.split('\n')

  let currentSection: MarkdownSection | null = null
  const contentLines: string[] = []

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)

    if (headingMatch?.[1] && headingMatch[2]) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join('\n').trim()
        sections.push(currentSection)
        contentLines.length = 0
      }

      // Start new section
      currentSection = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        content: '',
      }
    } else if (currentSection) {
      contentLines.push(line)
    }
  }

  // Save final section
  if (currentSection) {
    currentSection.content = contentLines.join('\n').trim()
    sections.push(currentSection)
  }

  return sections
}

/**
 * Parse verification output from a verifier agent.
 *
 * Looks for:
 * - APPROVE/ITERATE/REJECT recommendations
 * - Issue counts
 * - Critical issues
 *
 * @param output - Verifier output text
 * @returns Parsed verification result
 */
export function parseVerificationOutput(output: string): VerificationResult {
  const issues: VerificationResult['issues'] = []
  let recommendation: string | undefined
  let criticalCount = 0

  // Look for recommendation
  const recMatch = output.match(
    /(?:recommendation|verdict|decision)[:\s]*(approve|iterate|reject)/i
  )
  if (recMatch?.[1]) {
    recommendation = recMatch[1].toUpperCase()
  }

  // Look for explicit pass/fail
  const passMatch = output.match(/(?:all\s+)?(?:checks?\s+)?(?:pass(?:ed)?|approved)/i)
  const failMatch = output.match(
    /(?:issues?\s+found|failed?|needs?\s+(?:changes?|iteration)|changes?\s+required)/i
  )

  // Count issues by severity
  const criticalMatches = output.match(/(?:critical|blocker|severe)[:\s]+(\d+)/gi)
  if (criticalMatches) {
    for (const match of criticalMatches) {
      const num = Number.parseInt(match.match(/\d+/)?.[0] || '0', 10)
      criticalCount += num
    }
  }

  // Extract issues from markdown lists
  const issueMatches = output.matchAll(/[-*]\s*(?:\[(critical|major|minor|info)\])?\s*(.+)/gi)
  for (const match of issueMatches) {
    const severity = (match[1]?.toLowerCase() ||
      'minor') as VerificationResult['issues'][0]['severity']
    const descriptionText = match[2]
    if (!descriptionText) continue
    const description = descriptionText.trim()

    // Skip if it looks like a non-issue list item
    if (
      description.toLowerCase().includes('no issues') ||
      description.toLowerCase().includes('looks good') ||
      description.toLowerCase().includes('approved')
    ) {
      continue
    }

    if (severity === 'critical') {
      criticalCount++
    }

    issues.push({ severity, description })
  }

  // Determine if passed
  const passed =
    recommendation === 'APPROVE' ||
    (passMatch !== null && failMatch === null && criticalCount === 0)

  return {
    passed,
    recommendation,
    issueCount: issues.length,
    criticalCount,
    issues,
    feedback: output,
  }
}

/**
 * OutputValidator class for validating agent outputs.
 */
export class OutputValidator {
  private readonly logger: Logger

  constructor() {
    this.logger = new Logger('debug')
  }

  /**
   * Extract and validate JSON from agent output.
   *
   * @param output - Agent output text
   * @param schema - Optional schema to validate against
   * @returns Validation result
   */
  extractAndValidateJson(output: string, schema?: OutputSchema): ValidationResult {
    const json = extractJson(output)

    if (json === null) {
      return {
        valid: false,
        errors: ['No valid JSON found in output'],
        warnings: [],
      }
    }

    if (schema) {
      return validateSchema(json, schema)
    }

    return {
      valid: true,
      data: json,
      errors: [],
      warnings: [],
    }
  }

  /**
   * Parse verification output and validate.
   *
   * @param output - Verifier output text
   * @returns Verification result
   */
  parseVerification(output: string): VerificationResult {
    const result = parseVerificationOutput(output)

    this.logger.debug('Parsed verification output', {
      passed: result.passed,
      recommendation: result.recommendation,
      issueCount: result.issueCount,
      criticalCount: result.criticalCount,
    })

    return result
  }

  /**
   * Find a section in markdown by heading.
   *
   * @param markdown - Markdown text
   * @param heading - Heading to find (case-insensitive)
   * @returns Section content or undefined
   */
  findSection(markdown: string, heading: string): string | undefined {
    const sections = parseMarkdownSections(markdown)
    const section = sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase())
    return section?.content
  }

  /**
   * Format validation errors for display.
   *
   * @param result - Validation result
   * @returns Formatted error string
   */
  formatErrors(result: ValidationResult): string {
    if (result.valid) {
      return '✅ Validation passed'
    }

    let output = '❌ Validation failed:\n'
    for (const error of result.errors) {
      output += `  - ${error}\n`
    }

    if (result.warnings.length > 0) {
      output += '\n⚠️ Warnings:\n'
      for (const warning of result.warnings) {
        output += `  - ${warning}\n`
      }
    }

    return output.trim()
  }
}
