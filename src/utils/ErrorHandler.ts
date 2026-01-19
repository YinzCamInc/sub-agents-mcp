/**
 * Error context information for detailed error reporting.
 */
export interface ErrorContext {
  /** Request ID for tracing */
  requestId?: string

  /** Operation being performed when error occurred */
  operation?: string

  /** Additional metadata relevant to the error */
  metadata?: Record<string, unknown>

  /** Timestamp when error occurred */
  timestamp?: Date

  /** Component or service where error originated */
  component?: string
}

/**
 * Base application error class for structured error handling.
 *
 * Provides a standardized way to handle errors throughout the application
 * with error codes, HTTP status codes, and contextual information for proper
 * error response handling and debugging.
 *
 * @example
 * ```typescript
 * throw new AppError('Agent not found', 'AGENT_NOT_FOUND', 404, {
 *   requestId: 'req_123',
 *   operation: 'agent_execution',
 *   component: 'AgentManager'
 * })
 * ```
 */
export class AppError extends Error {
  /** Error code for programmatic error identification */
  public readonly code: string

  /** HTTP status code for error response handling */
  public readonly statusCode: number

  /** Context information for debugging and tracing */
  public readonly context: ErrorContext

  /**
   * Creates a new AppError instance.
   *
   * @param message - Human-readable error message
   * @param code - Error code for programmatic identification
   * @param statusCode - HTTP status code (default: 500)
   * @param context - Additional context information
   */
  constructor(message: string, code: string, statusCode = 500, context: ErrorContext = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.statusCode = statusCode
    this.context = {
      timestamp: new Date(),
      ...context,
    }

    // Maintains proper stack trace for where error was thrown (Node.js only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Converts error to a structured object for logging or API responses.
   *
   * @returns Structured error object
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      context: this.context,
      stack: this.stack,
    }
  }

  /**
   * Creates a user-friendly error message without sensitive information.
   *
   * @returns User-friendly error message
   */
  toUserMessage(): string {
    return `${this.message} (Error Code: ${this.code})`
  }
}

/**
 * Validation error class for input validation failures.
 *
 * Used when user input fails validation checks such as format validation,
 * required field checks, or constraint violations.
 * Automatically sets HTTP status code to 400 (Bad Request).
 *
 * @example
 * ```typescript
 * throw new ValidationError('Invalid email format', 'INVALID_EMAIL', {
 *   operation: 'user_input_validation',
 *   metadata: { field: 'email', value: 'invalid-email' }
 * })
 * ```
 */
export class ValidationError extends AppError {
  /**
   * Creates a new ValidationError instance.
   *
   * @param message - Description of the validation failure
   * @param code - Error code for the specific validation failure
   * @param context - Additional context information
   */
  constructor(message: string, code: string, context: ErrorContext = {}) {
    super(message, code, 400, {
      component: 'Validation',
      ...context,
    })
  }
}

/**
 * Agent execution error for agent-related failures.
 *
 * Used when agent execution fails, times out, or produces invalid output.
 * Automatically sets HTTP status code to 500 (Internal Server Error).
 *
 * @example
 * ```typescript
 * throw new AgentExecutionError('Agent timed out', 'AGENT_TIMEOUT', {
 *   operation: 'agent_execution',
 *   metadata: { agent: 'plan-creator', timeout: 300000 }
 * })
 * ```
 */
export class AgentExecutionError extends AppError {
  /** The agent that failed */
  public readonly agent: string | undefined

  /** The execution time before failure (ms) */
  public readonly executionTime: number | undefined

  /**
   * Creates a new AgentExecutionError instance.
   *
   * @param message - Description of the execution failure
   * @param code - Error code for the specific failure type
   * @param agent - Name of the agent that failed
   * @param executionTime - Execution time before failure (ms)
   * @param context - Additional context information
   */
  constructor(
    message: string,
    code: string,
    agent?: string,
    executionTime?: number,
    context: ErrorContext = {}
  ) {
    super(message, code, 500, {
      component: 'AgentExecution',
      metadata: {
        ...(context.metadata || {}),
        ...(agent !== undefined && { agent }),
        ...(executionTime !== undefined && { executionTime }),
      },
      ...context,
    })
    this.agent = agent
    this.executionTime = executionTime
  }

  /**
   * Creates a user-friendly error message with agent context.
   */
  override toUserMessage(): string {
    let msg = `Agent execution failed: ${this.message}`
    if (this.agent) {
      msg += ` (Agent: ${this.agent})`
    }
    msg += ` [${this.code}]`
    return msg
  }
}

/**
 * Workflow error for workflow-related failures.
 *
 * Used when workflow execution fails, state is invalid, or transitions fail.
 *
 * @example
 * ```typescript
 * throw new WorkflowError('Invalid phase transition', 'INVALID_TRANSITION', {
 *   metadata: { from: 'planning', to: 'testing-execution' }
 * })
 * ```
 */
export class WorkflowError extends AppError {
  /** The workflow ID */
  public readonly workflowId: string | undefined

  /** The current phase */
  public readonly phase: string | undefined

  /**
   * Creates a new WorkflowError instance.
   */
  constructor(
    message: string,
    code: string,
    workflowId?: string,
    phase?: string,
    context: ErrorContext = {}
  ) {
    super(message, code, 400, {
      component: 'Workflow',
      metadata: {
        ...(context.metadata || {}),
        ...(workflowId !== undefined && { workflowId }),
        ...(phase !== undefined && { phase }),
      },
      ...context,
    })
    this.workflowId = workflowId
    this.phase = phase
  }

  /**
   * Creates a user-friendly error message with workflow context.
   */
  override toUserMessage(): string {
    let msg = `Workflow error: ${this.message}`
    if (this.workflowId) {
      msg += ` (Workflow: ${this.workflowId})`
    }
    if (this.phase) {
      msg += ` [Phase: ${this.phase}]`
    }
    msg += ` [${this.code}]`
    return msg
  }
}

/**
 * Token budget exceeded error.
 *
 * Used when context size exceeds model token limits.
 */
export class TokenBudgetError extends AppError {
  /** Estimated token count */
  public readonly tokens: number

  /** Model token limit */
  public readonly limit: number

  /** Model identifier */
  public readonly model: string

  constructor(tokens: number, limit: number, model: string, context: ErrorContext = {}) {
    const percentage = Math.round((tokens / limit) * 100)
    super(
      `Context size (~${tokens.toLocaleString()} tokens) exceeds ${percentage}% of ${model} limit (${limit.toLocaleString()})`,
      'TOKEN_BUDGET_EXCEEDED',
      400,
      {
        component: 'TokenBudget',
        metadata: { tokens, limit, model, percentage },
        ...context,
      }
    )
    this.tokens = tokens
    this.limit = limit
    this.model = model
  }

  /**
   * Creates a user-friendly error message with recommendations.
   */
  override toUserMessage(): string {
    return `${this.message}. Consider: (1) Reducing context files, (2) Summarizing large files, (3) Using a model with higher token limit, or (4) Splitting the task.`
  }
}

/**
 * Format an error for user-friendly display.
 *
 * @param error - The error to format
 * @returns Formatted error string
 */
export function formatErrorForUser(error: unknown): string {
  if (error instanceof AppError) {
    return error.toUserMessage()
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

/**
 * Format an error for logging with full context.
 *
 * @param error - The error to format
 * @param additionalContext - Additional context to include
 * @returns Formatted error object for logging
 */
export function formatErrorForLogging(
  error: unknown,
  additionalContext?: Record<string, unknown>
): Record<string, unknown> {
  if (error instanceof AppError) {
    return {
      ...error.toJSON(),
      ...additionalContext,
    }
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...additionalContext,
    }
  }

  return {
    error: String(error),
    ...additionalContext,
  }
}

/**
 * Check if an error is retryable.
 *
 * @param error - The error to check
 * @returns Whether the operation should be retried
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) {
    // Timeout errors are retryable
    if (error.code.includes('TIMEOUT')) {
      return true
    }
    // Rate limit errors are retryable
    if (error.code.includes('RATE_LIMIT')) {
      return true
    }
    // Server errors (5xx) are generally retryable
    if (error.statusCode >= 500) {
      return true
    }
  }

  return false
}
