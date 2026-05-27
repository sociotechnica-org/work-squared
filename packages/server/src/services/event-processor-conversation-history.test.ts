import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventProcessor } from './event-processor.js'
import type { Message } from '@mariozechner/pi-ai'
import type { ChatMessage } from './pi/types.js'

const { createLoggerMock, loggerContainer } = vi.hoisted(() => {
  const factory = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })

  return {
    createLoggerMock: factory,
    loggerContainer: {
      logger: null as ReturnType<typeof factory> | null,
      logMessageEvent: vi.fn(),
    },
  }
})

const sentryContainer = vi.hoisted(() => {
  const makeScope = () => ({
    setTag: vi.fn(),
    setContext: vi.fn(),
  })

  return {
    captureException: vi.fn(),
    withScope: vi.fn((callback: (scope: ReturnType<typeof makeScope>) => void) => {
      callback(makeScope())
    }),
  }
})

vi.mock('@sentry/node', () => ({
  captureException: sentryContainer.captureException,
  withScope: sentryContainer.withScope,
}))

vi.mock('../utils/logger.js', () => {
  loggerContainer.logger = createLoggerMock()
  return {
    logger: loggerContainer.logger,
    storeLogger: vi.fn(() => createLoggerMock()),
    createContextLogger: vi.fn(() => createLoggerMock()),
    logMessageEvent: loggerContainer.logMessageEvent,
  }
})

vi.mock('./processed-message-tracker.js', () => ({
  // Production constructs this with `new`, so the mock must be constructible.
  ProcessedMessageTracker: vi.fn(function ProcessedMessageTrackerMock() {
    return {
      initialize: vi.fn().mockResolvedValue(undefined),
      isProcessed: vi.fn(),
      markProcessed: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }
  }),
}))

// Mock StoreManager with EventEmitter methods
const createMockStoreManager = () => ({
  on: vi.fn(),
  emit: vi.fn(),
  removeListener: vi.fn(),
  getAllStores: vi.fn(() => new Map()),
  getStore: vi.fn(),
  updateActivity: vi.fn(),
})

const createMockAgentState = (messages: unknown[] = []) => ({
  systemPrompt: '',
  messages,
})

const getQueryLabel = (query: unknown): string => {
  if (
    typeof query === 'object' &&
    query !== null &&
    'label' in query &&
    typeof query.label === 'string'
  ) {
    return query.label
  }

  return ''
}

const createConversationContextQueryMock = ({
  conversations = [],
  workers = [],
  chatMessages = [],
}: {
  conversations?: unknown[]
  workers?: unknown[]
  chatMessages?: ChatMessage[]
}) =>
  vi.fn((query: unknown) => {
    const label = getQueryLabel(query)

    if (label.includes("FROM 'conversations'")) {
      return conversations
    }

    if (label.includes("FROM 'workers'")) {
      return workers
    }

    if (label.includes("FROM 'chatMessages'")) {
      return chatMessages
    }

    return []
  })

describe('EventProcessor conversation history builder', () => {
  let eventProcessor: EventProcessor

  beforeEach(() => {
    eventProcessor = new EventProcessor(createMockStoreManager() as any)
    vi.clearAllMocks()
  })

  afterEach(() => {
    eventProcessor.stopAll()
    vi.clearAllMocks()
  })

  it('excludes the live user message from the conversation history', () => {
    const userMessage: ChatMessage = {
      id: 'user-1',
      conversationId: 'conv-1',
      role: 'user',
      message: 'Hello there',
      createdAt: new Date('2024-01-01T00:00:10Z'),
    }

    const chatHistory: ChatMessage[] = [
      {
        id: 'system-1',
        conversationId: 'conv-1',
        role: 'system',
        message: 'You are a helpful assistant',
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
      userMessage,
    ]

    const conversationHistory = (eventProcessor as any).buildConversationHistory(
      chatHistory,
      userMessage
    ) as Message[]

    expect(conversationHistory).toHaveLength(0)
    expect(loggerContainer.logger!.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        userMessageId: 'user-1',
      }),
      'Trimming current user message from conversation history before LLM call'
    )
  })

  it('keeps historical messages when the latest entry is not the live user message', () => {
    const userMessage: ChatMessage = {
      id: 'user-2',
      conversationId: 'conv-1',
      role: 'user',
      message: 'New input',
      createdAt: new Date('2024-01-01T00:01:00Z'),
    }

    const chatHistory: ChatMessage[] = [
      {
        id: 'system-1',
        conversationId: 'conv-1',
        role: 'system',
        message: 'You are a helpful assistant',
        createdAt: new Date('2024-01-01T00:00:00Z'),
      },
      {
        id: 'user-previous',
        conversationId: 'conv-1',
        role: 'user',
        message: 'Previous input',
        createdAt: new Date('2024-01-01T00:00:30Z'),
      },
      {
        id: 'assistant-1',
        conversationId: 'conv-1',
        role: 'assistant',
        message: 'Assistant response',
        createdAt: new Date('2024-01-01T00:00:40Z'),
      },
    ]

    const conversationHistory = (eventProcessor as any).buildConversationHistory(
      chatHistory,
      userMessage
    ) as Message[]

    expect(conversationHistory).toHaveLength(2)
    expect(
      conversationHistory.map(({ role, content }: Message) => [
        role,
        role === 'assistant'
          ? content.find(part => part.type === 'text')?.text
          : typeof content === 'string'
            ? content
            : null,
      ])
    ).toEqual([
      ['user', 'Previous input'],
      ['assistant', 'Assistant response'],
    ])
    expect(loggerContainer.logger!.debug).not.toHaveBeenCalled()
  })

  it('logs a warning when duplicate consecutive user messages remain', () => {
    const userMessage: ChatMessage = {
      id: 'user-latest',
      conversationId: 'conv-1',
      role: 'user',
      message: 'Latest input',
      createdAt: new Date('2024-01-01T00:02:00Z'),
    }

    const chatHistory: ChatMessage[] = [
      {
        id: 'user-1',
        conversationId: 'conv-1',
        role: 'user',
        message: 'Repeated input',
        createdAt: new Date('2024-01-01T00:00:10Z'),
      },
      {
        id: 'user-2',
        conversationId: 'conv-1',
        role: 'user',
        message: 'Repeated input',
        createdAt: new Date('2024-01-01T00:00:20Z'),
      },
    ]

    const conversationHistory = (eventProcessor as any).buildConversationHistory(
      chatHistory,
      userMessage
    ) as Message[]

    expect(conversationHistory).toHaveLength(2)
    expect(
      conversationHistory
        .filter((message: Message) => message.role === 'user')
        .map(message => (typeof message.content === 'string' ? message.content : ''))
    ).toEqual(['Repeated input', 'Repeated input'])
    expect(loggerContainer.logger!.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        userMessageId: 'user-latest',
        duplicates: expect.arrayContaining([
          expect.objectContaining({ preview: 'Repeated input' }),
        ]),
      }),
      'Detected duplicate consecutive user messages in conversation history'
    )
  })

  it('detects assistant error messages using stopReason and errorMessage', () => {
    const assistantErrorMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Something failed' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-opus-4-5',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'error',
      errorMessage: 'Provider error',
      timestamp: Date.now(),
    }

    const assistantSuccessMessage: Message = {
      ...assistantErrorMessage,
      stopReason: 'stop',
      errorMessage: undefined,
    }

    expect((eventProcessor as any).isAssistantErrorMessage(assistantErrorMessage)).toBe(true)
    expect((eventProcessor as any).isAssistantErrorMessage(assistantSuccessMessage)).toBe(false)
  })

  it('sanitizes Pi storage path segments to prevent dot-segment traversal', () => {
    expect((eventProcessor as any).sanitizePiSegment('.')).toBe('_')
    expect((eventProcessor as any).sanitizePiSegment('..')).toBe('__')
    expect((eventProcessor as any).sanitizePiSegment('../..')).toBe('_____')
    expect((eventProcessor as any).sanitizePiSegment('workspace.dev')).toBe('workspace_dev')
    expect((eventProcessor as any).sanitizePiSegment('workspace-dev_01')).toBe('workspace-dev_01')
  })

  it('reports actual Pi iterations from turn_end events', async () => {
    const commit = vi.fn()
    const currentUserMessage: ChatMessage = {
      id: 'message-1',
      conversationId: 'conversation-1',
      role: 'user',
      message: 'Plan this task',
      createdAt: new Date('2024-01-01T00:01:00Z'),
    }
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []
    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        for (let i = 0; i < 3; i++) {
          for (const listener of listeners) {
            listener({ type: 'turn_end', message: { role: 'assistant' }, toolResults: [] })
          }
        }
        for (const listener of listeners) {
          listener({ type: 'agent_end', messages: [] })
        }
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop('store-1', currentUserMessage, {
      stopping: false,
    } as any)

    expect(completed).toBe(true)
    const completionEvents = commit.mock.calls.filter(
      ([event]: any[]) => event?.name === 'v1.LLMResponseCompleted'
    )
    expect(completionEvents.length).toBe(1)
    expect(completionEvents[0][0].args.iterations).toBe(3)

    processor.stopAll()
  })

  it('seeds Pi agent prompt and historical messages before prompting', async () => {
    const commit = vi.fn()
    const historicalUserMessage: ChatMessage = {
      id: 'message-0',
      conversationId: 'conversation-1',
      role: 'user',
      message: 'Previous context',
      createdAt: new Date('2024-01-01T00:00:00Z'),
    }
    const currentUserMessage: ChatMessage = {
      id: 'message-1',
      conversationId: 'conversation-1',
      role: 'user',
      message: 'Plan this task',
      createdAt: new Date('2024-01-01T00:01:00Z'),
    }
    const store = {
      commit,
      query: createConversationContextQueryMock({
        conversations: [{ id: 'conversation-1' }],
        chatMessages: [historicalUserMessage, currentUserMessage],
      }),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []
    const fakeAgentState = createMockAgentState()
    let stateBeforePrompt: ReturnType<typeof createMockAgentState> | undefined
    const fakeSession = {
      agent: {
        state: fakeAgentState,
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        stateBeforePrompt = {
          systemPrompt: fakeAgentState.systemPrompt,
          messages: [...fakeAgentState.messages],
        }

        for (const listener of listeners) {
          listener({ type: 'agent_end', messages: [] })
        }
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop('store-1', currentUserMessage, {
      stopping: false,
    } as any)

    expect(completed).toBe(true)
    expect(stateBeforePrompt?.systemPrompt).toEqual(expect.any(String))
    expect(stateBeforePrompt?.systemPrompt).not.toBe('')
    expect(stateBeforePrompt?.messages).toEqual([
      {
        role: 'user',
        content: 'Previous context',
        timestamp: historicalUserMessage.createdAt.getTime(),
      },
    ])

    processor.stopAll()
  })

  it('suppresses successful tool chatter while keeping tool errors', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []

    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        const assistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          stopReason: 'stop',
        }

        for (const listener of listeners) {
          listener({
            type: 'tool_execution_start',
            toolName: 'update_project',
            toolCallId: 'tool-1',
          })
          listener({
            type: 'tool_execution_end',
            toolName: 'update_project',
            toolCallId: 'tool-1',
            isError: false,
            result: {
              details: {
                formatted: 'Tool executed successfully. Result: {"success": true}',
              },
            },
          })
          listener({
            type: 'tool_execution_end',
            toolName: 'update_project',
            toolCallId: 'tool-2',
            isError: true,
            result: {
              details: {
                formatted: 'Tool execution failed',
              },
            },
          })
          listener({ type: 'message_end', message: assistantMessage })
          listener({ type: 'agent_end', messages: [assistantMessage] })
        }
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-tool-noise',
        conversationId: 'conversation-tool-noise',
        role: 'user',
        message: 'Update the project and tell me when done',
        createdAt: new Date(),
      } satisfies ChatMessage,
      { stopping: false } as any
    )

    expect(completed).toBe(true)

    const llmResponseReceived = commit.mock.calls
      .map(([event]: any[]) => event)
      .filter((event: any) => event?.name === 'v1.LLMResponseReceived')

    expect(
      llmResponseReceived.some(
        (event: any) =>
          event.args?.llmMetadata?.source === 'tool-execution' ||
          event.args?.llmMetadata?.source === 'tool-result'
      )
    ).toBe(false)

    expect(
      llmResponseReceived.some(
        (event: any) =>
          event.args?.llmMetadata?.source === 'tool-error' &&
          event.args?.message === 'Tool execution failed'
      )
    ).toBe(true)

    expect(
      llmResponseReceived.some(
        (event: any) => event.args?.llmMetadata?.source === 'pi' && event.args?.message === 'Done.'
      )
    ).toBe(true)

    processor.stopAll()
  })

  it('emits only one assistant response when Pi sends multiple assistant messages for one prompt', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []

    const assistantMessageA = {
      role: 'assistant',
      content: [{ type: 'text', text: 'First draft response.' }],
      stopReason: 'stop',
    }
    const assistantMessageB = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Final response.' }],
      stopReason: 'stop',
    }

    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        for (const listener of listeners) {
          listener({ type: 'message_end', message: assistantMessageA })
          listener({ type: 'message_end', message: assistantMessageB })
          listener({ type: 'agent_end', messages: [assistantMessageA, assistantMessageB] })
        }
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-multi-assistant',
        conversationId: 'conversation-multi-assistant',
        role: 'user',
        message: 'Tell me what changed',
        createdAt: new Date(),
      } satisfies ChatMessage,
      { stopping: false } as any
    )

    expect(completed).toBe(true)

    const llmResponseReceived = commit.mock.calls
      .map(([event]: any[]) => event)
      .filter((event: any) => event?.name === 'v1.LLMResponseReceived')

    const piAssistantResponses = llmResponseReceived.filter(
      (event: any) => event.args?.llmMetadata?.source === 'pi'
    )

    expect(piAssistantResponses).toHaveLength(1)
    expect(piAssistantResponses[0].args.message).toBe('Final response.')

    processor.stopAll()
  })

  it('captures Pi prompt errors in Sentry with failure completion metadata', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn(() => vi.fn()),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockRejectedValue(new Error('Pi prompt failed')),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-2',
        conversationId: 'conversation-2',
        role: 'user',
        message: 'Do the thing',
        createdAt: new Date(),
      } satisfies ChatMessage,
      { stopping: false } as any
    )

    expect(completed).toBe(false)
    expect(sentryContainer.captureException).toHaveBeenCalledTimes(1)

    const completionEvents = commit.mock.calls.filter(
      ([event]: any[]) => event?.name === 'v1.LLMResponseCompleted'
    )
    expect(completionEvents.length).toBe(1)
    expect(completionEvents[0][0].args.success).toBe(false)
    expect(completionEvents[0][0].args.iterations).toBe(0)

    processor.stopAll()
  })

  it('preserves buffered assistant reply when prompt fails after output', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []
    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'This answer should be kept.' }],
      stopReason: 'stop',
    }

    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        for (const listener of listeners) {
          listener({ type: 'message_end', message: assistantMessage })
        }
        throw new Error('late prompt failure')
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-late-error',
        conversationId: 'conversation-late-error',
        role: 'user',
        message: 'Give me a response',
        createdAt: new Date(),
      } satisfies ChatMessage,
      { stopping: false } as any
    )

    expect(completed).toBe(false)
    expect(sentryContainer.captureException).toHaveBeenCalledTimes(1)

    const responses = commit.mock.calls
      .map(([event]: any[]) => event)
      .filter((event: any) => event?.name === 'v1.LLMResponseReceived')

    const piResponses = responses.filter((event: any) => event.args?.llmMetadata?.source === 'pi')
    const errorResponses = responses.filter(
      (event: any) => event.args?.llmMetadata?.source === 'error'
    )

    expect(piResponses).toHaveLength(1)
    expect(piResponses[0].args.message).toBe('This answer should be kept.')
    expect(errorResponses).toHaveLength(0)

    const completionEvents = commit.mock.calls.filter(
      ([event]: any[]) => event?.name === 'v1.LLMResponseCompleted'
    )
    expect(completionEvents.length).toBe(1)
    expect(completionEvents[0][0].args.success).toBe(false)

    processor.stopAll()
  })

  it('does not emit buffered assistant replies once store shutdown has started', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []
    const storeState = { stopping: false } as any
    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Do not emit during shutdown.' }],
      stopReason: 'stop',
    }

    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        for (const listener of listeners) {
          listener({ type: 'message_end', message: assistantMessage })
        }
        storeState.stopping = true
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-stopping',
        conversationId: 'conversation-stopping',
        role: 'user',
        message: 'respond while stopping',
        createdAt: new Date(),
      } satisfies ChatMessage,
      storeState
    )

    expect(completed).toBe(true)

    const responses = commit.mock.calls
      .map(([event]: any[]) => event)
      .filter((event: any) => event?.name === 'v1.LLMResponseReceived')

    expect(responses).toHaveLength(0)

    processor.stopAll()
  })

  it('does not replay historical assistant text from agent_end as a new reply', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []
    const historicalAssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Older reply from previous turn.' }],
      stopReason: 'stop',
    }

    const fakeSession = {
      agent: {
        // Simulate reused session with existing history already present.
        state: createMockAgentState([historicalAssistantMessage]),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        for (const listener of listeners) {
          listener({ type: 'agent_end', messages: [historicalAssistantMessage] })
        }
        throw new Error('prompt failed after no new assistant output')
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-no-new-assistant',
        conversationId: 'conversation-no-new-assistant',
        role: 'user',
        message: 'respond please',
        createdAt: new Date(),
      } satisfies ChatMessage,
      { stopping: false } as any
    )

    expect(completed).toBe(false)

    const responses = commit.mock.calls
      .map(([event]: any[]) => event)
      .filter((event: any) => event?.name === 'v1.LLMResponseReceived')

    expect(
      responses.some((event: any) => event.args?.message === 'Older reply from previous turn.')
    ).toBe(false)
    expect(responses.some((event: any) => event.args?.llmMetadata?.source === 'error')).toBe(true)

    processor.stopAll()
  })

  it('emits fallback assistant error when Pi reports error state without text', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []
    const assistantErrorMessage: any = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Provider error',
    }

    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        for (const listener of listeners) {
          listener({ type: 'message_end', message: assistantErrorMessage })
          listener({ type: 'agent_end', messages: [assistantErrorMessage] })
        }
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-3',
        conversationId: 'conversation-3',
        role: 'user',
        message: 'Are you there?',
        createdAt: new Date(),
      } satisfies ChatMessage,
      { stopping: false } as any
    )

    expect(completed).toBe(false)
    expect(
      commit.mock.calls.some(
        ([event]: any[]) =>
          event?.name === 'v1.LLMResponseReceived' &&
          event?.args?.modelId === 'error' &&
          event?.args?.message?.includes('Sorry, I encountered an error')
      )
    ).toBe(true)

    const completionEvents = commit.mock.calls.filter(
      ([event]: any[]) => event?.name === 'v1.LLMResponseCompleted'
    )
    expect(completionEvents.length).toBe(1)
    expect(completionEvents[0][0].args.success).toBe(false)
    expect(sentryContainer.captureException).toHaveBeenCalledTimes(1)

    processor.stopAll()
  })

  it('does not emit fallback error when a tool error response was already emitted', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    const listeners: Array<(event: any) => void> = []
    const assistantErrorMessage: any = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Tool call failed',
    }

    const fakeSession = {
      agent: {
        state: createMockAgentState(),
      },
      subscribe: vi.fn((listener: (event: any) => void) => {
        listeners.push(listener)
        return vi.fn()
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockImplementation(async () => {
        for (const listener of listeners) {
          listener({
            type: 'tool_execution_end',
            toolName: 'update_project',
            toolCallId: 'tool-error-1',
            isError: true,
            result: {
              details: {
                formatted: 'Tool execution failed',
              },
            },
          })
          listener({ type: 'message_end', message: assistantErrorMessage })
          listener({ type: 'agent_end', messages: [assistantErrorMessage] })
        }
      }),
    }

    vi.spyOn(processor as any, 'getOrCreatePiSession').mockResolvedValue({
      session: fakeSession,
      sessionDir: '/tmp/pi-session',
      lastAccessedAt: Date.now(),
    })

    const completed = await (processor as any).runAgenticLoop(
      'store-1',
      {
        id: 'message-tool-error-only',
        conversationId: 'conversation-tool-error-only',
        role: 'user',
        message: 'Update the project',
        createdAt: new Date(),
      } satisfies ChatMessage,
      { stopping: false } as any
    )

    expect(completed).toBe(false)

    const responses = commit.mock.calls
      .map(([event]: any[]) => event)
      .filter((event: any) => event?.name === 'v1.LLMResponseReceived')

    const toolErrorResponses = responses.filter(
      (event: any) => event.args?.llmMetadata?.source === 'tool-error'
    )
    const fallbackErrorResponses = responses.filter(
      (event: any) => event.args?.llmMetadata?.source === 'error'
    )

    expect(toolErrorResponses).toHaveLength(1)
    expect(toolErrorResponses[0].args.message).toBe('Tool execution failed')
    expect(fallbackErrorResponses).toHaveLength(0)

    const completionEvents = commit.mock.calls.filter(
      ([event]: any[]) => event?.name === 'v1.LLMResponseCompleted'
    )
    expect(completionEvents.length).toBe(1)
    expect(completionEvents[0][0].args.success).toBe(false)
    expect(sentryContainer.captureException).toHaveBeenCalledTimes(1)

    processor.stopAll()
  })

  it('marks handleUserMessage as failed when agentic loop reports failure', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    vi.spyOn(processor as any, 'runAgenticLoop').mockResolvedValue(false)
    const processQueuedMessagesSpy = vi
      .spyOn(processor as any, 'processQueuedMessages')
      .mockResolvedValue(undefined)

    const lifecycleTracker = (processor as any).lifecycleTracker
    const recordErrorSpy = vi.spyOn(lifecycleTracker, 'recordError')
    const recordCompletedSpy = vi.spyOn(lifecycleTracker, 'recordCompleted')
    lifecycleTracker.startTracking('message-4', 'store-1', 'conversation-4')

    const storeState = {
      subscriptions: [],
      eventBuffer: { events: [], lastFlushed: new Date(), processing: false },
      errorCount: 0,
      processingQueue: Promise.resolve(),
      stopping: false,
      activeConversations: new Set<string>(),
      messageQueue: {
        enqueue: vi.fn(),
        hasMessages: vi.fn(() => false),
        dequeue: vi.fn(() => null),
        getQueueLength: vi.fn(() => 0),
      },
      conversationProcessors: new Map(),
      piSessions: new Map(),
    }

    await (processor as any).handleUserMessage(
      'store-1',
      {
        id: 'message-4',
        conversationId: 'conversation-4',
        role: 'user',
        message: 'Try again',
        createdAt: new Date(),
      } satisfies ChatMessage,
      storeState as any
    )

    expect(recordErrorSpy).toHaveBeenCalledWith(
      'message-4',
      'Agentic loop reported failure during processing',
      'AGENTIC_LOOP_FAILED'
    )
    expect(recordCompletedSpy).not.toHaveBeenCalledWith('message-4')
    expect(processQueuedMessagesSpy).toHaveBeenCalledTimes(1)
    expect(processQueuedMessagesSpy).toHaveBeenCalledWith('store-1', 'conversation-4', storeState)
    expect(loggerContainer.logMessageEvent).toHaveBeenCalledWith(
      'warn',
      expect.objectContaining({
        messageId: 'message-4',
        action: 'processing_failed',
      }),
      'Message processing failed'
    )

    processor.stopAll()
  })

  it('emits llmResponseCompleted only once when handleUserMessage catches a thrown agent error', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    vi.spyOn(processor as any, 'runAgenticLoop').mockRejectedValue(new Error('agent exploded'))

    const lifecycleTracker = (processor as any).lifecycleTracker
    lifecycleTracker.startTracking('message-throw', 'store-1', 'conversation-throw')

    await (processor as any).handleUserMessage(
      'store-1',
      {
        id: 'message-throw',
        conversationId: 'conversation-throw',
        role: 'user',
        message: 'boom',
        createdAt: new Date(),
      } satisfies ChatMessage,
      {
        subscriptions: [],
        eventBuffer: { events: [], lastFlushed: new Date(), processing: false },
        errorCount: 0,
        processingQueue: Promise.resolve(),
        stopping: false,
        activeConversations: new Set<string>(),
        messageQueue: {
          enqueue: vi.fn(),
          hasMessages: vi.fn(() => false),
          dequeue: vi.fn(() => null),
          getQueueLength: vi.fn(() => 0),
        },
        conversationProcessors: new Map(),
        piSessions: new Map(),
      } as any
    )

    const completionEvents = commit.mock.calls.filter(
      ([event]: any[]) => event?.name === 'v1.LLMResponseCompleted'
    )
    expect(completionEvents).toHaveLength(1)
    expect(completionEvents[0][0].args.success).toBe(false)

    processor.stopAll()
  })

  it('emits llmResponseCompleted only once when processQueuedMessage catches a thrown agent error', async () => {
    const commit = vi.fn()
    const store = {
      commit,
      query: vi.fn().mockReturnValue([]),
    }
    const storeManager = createMockStoreManager()
    storeManager.getStore = vi.fn(() => store as any)

    const processor = new EventProcessor(storeManager as any)
    vi.spyOn(processor as any, 'runAgenticLoop').mockRejectedValue(
      new Error('queued agent exploded')
    )

    const lifecycleTracker = (processor as any).lifecycleTracker
    lifecycleTracker.startTracking('queued-message-throw', 'store-1', 'conversation-throw')

    await (processor as any).processQueuedMessage(
      'store-1',
      {
        id: 'queued-message-throw',
        conversationId: 'conversation-throw',
        role: 'user',
        message: 'boom',
        createdAt: new Date(),
      } satisfies ChatMessage,
      {
        subscriptions: [],
        eventBuffer: { events: [], lastFlushed: new Date(), processing: false },
        errorCount: 0,
        processingQueue: Promise.resolve(),
        stopping: false,
        activeConversations: new Set<string>(),
        messageQueue: {
          enqueue: vi.fn(),
          getQueueLength: vi.fn(() => 0),
        },
        conversationProcessors: new Map(),
        piSessions: new Map(),
      } as any
    )

    const completionEvents = commit.mock.calls.filter(
      ([event]: any[]) => event?.name === 'v1.LLMResponseCompleted'
    )
    expect(completionEvents).toHaveLength(1)
    expect(completionEvents[0][0].args.success).toBe(false)

    processor.stopAll()
  })

  it('evicts least-recently-used Pi sessions when cache capacity is reached', async () => {
    const disposeOldest = vi.fn().mockResolvedValue(undefined)
    const disposeNewest = vi.fn().mockResolvedValue(undefined)
    const storeState = {
      activeConversations: new Set<string>(),
      piSessions: new Map<string, any>([
        [
          'conv-old',
          { session: { dispose: disposeOldest }, sessionDir: '/tmp/old', lastAccessedAt: 100 },
        ],
        [
          'conv-new',
          { session: { dispose: disposeNewest }, sessionDir: '/tmp/new', lastAccessedAt: 200 },
        ],
      ]),
    }

    ;(eventProcessor as any).maxPiSessionsPerStore = 2
    ;(eventProcessor as any).piSessionIdleTtlMs = 0
    await (eventProcessor as any).evictPiSessionsIfNeeded('store-1', storeState, 'conv-incoming')

    expect(disposeOldest).toHaveBeenCalledTimes(1)
    expect(disposeNewest).not.toHaveBeenCalled()
    expect(storeState.piSessions.has('conv-old')).toBe(false)
    expect(storeState.piSessions.has('conv-new')).toBe(true)
  })

  it('evicts sessions even when async dispose rejects', async () => {
    const disposeRejecting = vi.fn().mockRejectedValue(new Error('dispose failed'))
    const storeState = {
      activeConversations: new Set<string>(),
      piSessions: new Map<string, any>([
        [
          'conv-old',
          {
            session: { dispose: disposeRejecting },
            sessionDir: '/tmp/old',
            lastAccessedAt: 100,
          },
        ],
      ]),
    }

    ;(eventProcessor as any).maxPiSessionsPerStore = 1
    ;(eventProcessor as any).piSessionIdleTtlMs = 0
    await (eventProcessor as any).evictPiSessionsIfNeeded('store-1', storeState, 'conv-incoming')

    expect(disposeRejecting).toHaveBeenCalledTimes(1)
    expect(storeState.piSessions.has('conv-old')).toBe(false)
  })

  it('returns cached Pi session without evicting other sessions', async () => {
    const disposeCached = vi.fn().mockResolvedValue(undefined)
    const disposeOther = vi.fn().mockResolvedValue(undefined)
    const cachedEntry = {
      session: { dispose: disposeCached },
      sessionDir: '/tmp/cached',
      lastAccessedAt: 100,
    }
    const storeState = {
      activeConversations: new Set<string>(),
      piSessions: new Map<string, any>([
        ['conv-cached', cachedEntry],
        [
          'conv-other',
          { session: { dispose: disposeOther }, sessionDir: '/tmp/other', lastAccessedAt: 50 },
        ],
      ]),
    }

    ;(eventProcessor as any).maxPiSessionsPerStore = 1
    ;(eventProcessor as any).piSessionIdleTtlMs = 0

    const result = await (eventProcessor as any).getOrCreatePiSession(
      'store-1',
      'conv-cached',
      storeState,
      {} as any
    )

    expect(result).toBe(cachedEntry)
    expect(disposeOther).not.toHaveBeenCalled()
    expect(storeState.piSessions.has('conv-other')).toBe(true)
    expect(cachedEntry.lastAccessedAt).toBeGreaterThan(100)
  })

  it('configures Braintrust-backed Pi model when LLM_PROVIDER=braintrust', () => {
    const previousProvider = process.env.LLM_PROVIDER
    const previousBraintrustKey = process.env.BRAINTRUST_API_KEY
    const previousBraintrustProjectId = process.env.BRAINTRUST_PROJECT_ID
    const previousBraintrustModel = process.env.BRAINTRUST_MODEL
    const previousBraintrustBaseUrl = process.env.BRAINTRUST_BASE_URL

    process.env.LLM_PROVIDER = 'braintrust'
    process.env.BRAINTRUST_API_KEY = 'test-braintrust-api-key'
    process.env.BRAINTRUST_PROJECT_ID = 'test-project-id'
    process.env.BRAINTRUST_MODEL = 'anthropic/claude-3-7-sonnet'
    process.env.BRAINTRUST_BASE_URL = 'https://api.braintrust.dev/v1/proxy'

    try {
      const processor = new EventProcessor(createMockStoreManager() as any)
      const braintrustModel = (processor as any).piModel

      expect(braintrustModel?.provider).toBe('braintrust')
      expect(braintrustModel?.api).toBe('openai-completions')
      expect(braintrustModel?.id).toBe('anthropic/claude-3-7-sonnet')
      expect(braintrustModel?.baseUrl).toBe('https://api.braintrust.dev/v1/proxy')
      expect(braintrustModel?.headers?.['x-bt-parent']).toBe('project_id:test-project-id')
      expect(braintrustModel?.compat?.supportsStore).toBe(false)
      expect(braintrustModel?.compat?.maxTokensField).toBe('max_tokens')

      const modelRegistry = { registerProvider: vi.fn() }
      ;(processor as any).configurePiProviderOverrides(modelRegistry)
      expect(modelRegistry.registerProvider).toHaveBeenCalledWith('braintrust', {
        baseUrl: 'https://api.braintrust.dev/v1/proxy',
        apiKey: 'BRAINTRUST_API_KEY',
        headers: { 'x-bt-parent': 'project_id:test-project-id' },
      })

      processor.stopAll()
    } finally {
      if (previousProvider === undefined) {
        delete process.env.LLM_PROVIDER
      } else {
        process.env.LLM_PROVIDER = previousProvider
      }

      if (previousBraintrustKey === undefined) {
        delete process.env.BRAINTRUST_API_KEY
      } else {
        process.env.BRAINTRUST_API_KEY = previousBraintrustKey
      }

      if (previousBraintrustProjectId === undefined) {
        delete process.env.BRAINTRUST_PROJECT_ID
      } else {
        process.env.BRAINTRUST_PROJECT_ID = previousBraintrustProjectId
      }

      if (previousBraintrustModel === undefined) {
        delete process.env.BRAINTRUST_MODEL
      } else {
        process.env.BRAINTRUST_MODEL = previousBraintrustModel
      }

      if (previousBraintrustBaseUrl === undefined) {
        delete process.env.BRAINTRUST_BASE_URL
      } else {
        process.env.BRAINTRUST_BASE_URL = previousBraintrustBaseUrl
      }
    }
  })

  it('uses stub responses when LLM_PROVIDER=stub', async () => {
    const previousProvider = process.env.LLM_PROVIDER
    const previousStubResponse = process.env.LLM_STUB_DEFAULT_RESPONSE

    process.env.LLM_PROVIDER = 'stub'
    process.env.LLM_STUB_DEFAULT_RESPONSE = 'stub says hi'

    try {
      const commit = vi.fn()
      const stubStore = {
        commit,
        query: vi.fn(),
      }
      const storeManager = createMockStoreManager()
      storeManager.getStore = vi.fn(() => stubStore as any)

      const stubProcessor = new EventProcessor(storeManager as any)
      const completed = await (stubProcessor as any).runAgenticLoop(
        'store-1',
        {
          id: 'user-msg-1',
          conversationId: 'conv-1',
          role: 'user',
          message: 'ping',
          createdAt: new Date(),
        } satisfies ChatMessage,
        {} as any
      )

      expect(completed).toBe(true)
      expect((stubProcessor as any).piModel).toBeUndefined()
      expect(
        commit.mock.calls.some(
          ([event]: any[]) =>
            event?.name === 'v1.LLMResponseReceived' &&
            event?.args?.modelId === 'stub' &&
            event?.args?.message === 'stub says hi'
        )
      ).toBe(true)

      stubProcessor.stopAll()
    } finally {
      if (previousProvider === undefined) {
        delete process.env.LLM_PROVIDER
      } else {
        process.env.LLM_PROVIDER = previousProvider
      }

      if (previousStubResponse === undefined) {
        delete process.env.LLM_STUB_DEFAULT_RESPONSE
      } else {
        process.env.LLM_STUB_DEFAULT_RESPONSE = previousStubResponse
      }
    }
  })
})
