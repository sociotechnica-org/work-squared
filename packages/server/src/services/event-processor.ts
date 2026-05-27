import type { Store as LiveStore } from '@livestore/livestore'
import { queryDb } from '@livestore/livestore'
import * as Sentry from '@sentry/node'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { StoreManager } from './store-manager.js'
import { tables, events } from '@lifebuild/shared/schema'
import { DEFAULT_MODEL, resolveLifecycleState, type PlanningAttributes } from '@lifebuild/shared'
import {
  getRoomDefinitionByRoomId,
  createProjectRoomDefinition,
  type ProjectRoomParameters,
} from '@lifebuild/shared/rooms'
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from '@mariozechner/pi-coding-agent'
import { getModel, type AssistantMessage, type Message, type Model } from '@mariozechner/pi-ai'
import { MessageQueueManager } from './message-queue-manager.js'
import { AsyncQueueProcessor } from './async-queue-processor.js'
import { ProcessedMessageTracker } from './processed-message-tracker.js'
import { logger, storeLogger, createContextLogger, logMessageEvent } from '../utils/logger.js'
import {
  getMessageLifecycleTracker,
  destroyMessageLifecycleTracker,
  type MessageLifecycleTracker,
} from './message-lifecycle-tracker.js'
import {
  createOrchestrationTelemetry,
  getIncidentDashboardUrl,
} from '../utils/orchestration-telemetry.js'
import { buildSystemPrompt } from './pi/prompts.js'
import { createPiTools } from './pi/tools.js'
import { createStubResponder } from './pi/stub-responder.js'
import { PiInputValidator } from './pi/input-validator.js'
import type {
  EventBuffer,
  ProcessedEvent,
  ChatMessage,
  WorkerContext,
  NavigationContext,
} from './pi/types.js'

const toTimestamp = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }

  if (typeof value === 'string') {
    const date = new Date(value)
    const time = date.getTime()
    return Number.isNaN(time) ? null : time
  }

  return null
}

const toIsoString = (timestamp: number | null): string | null => {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return null
  }

  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

interface StoreProcessingState {
  subscriptions: Array<() => void>
  eventBuffer: EventBuffer
  errorCount: number
  lastError?: Error
  processingQueue: Promise<void>
  stopping: boolean
  // Chat processing state
  activeConversations: Set<string> // Track conversations currently being processed
  messageQueue: MessageQueueManager // Queue of pending messages per conversation
  conversationProcessors: Map<string, AsyncQueueProcessor> // Per-conversation async processors
  piSessions: Map<string, PiConversationSession>
}

interface PiConversationSession {
  session: AgentSession
  sessionDir: string
  lastAccessedAt: number
}

interface PiAgentResources {
  agentDir: string
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
  resourceLoader: DefaultResourceLoader
}

interface LiveStoreStats {
  chatMessages: number
  userMessages: number
  assistantMessages: number
  processedUserMessages: number
  pendingUserMessages: number
  conversations: number
  lastMessageAt: string | null
  lastUserMessageAt: string | null
  lastAssistantMessageAt: string | null
}

type LiveStoreStatsEntry = LiveStoreStats | { error: string }

interface LiveStoreStatsResult {
  perStore: Map<string, LiveStoreStatsEntry>
  totals: LiveStoreStats
}

export class EventProcessor {
  private storeManager: StoreManager
  private storeStates: Map<string, StoreProcessingState> = new Map()
  private readonly maxBufferSize = 100
  private readonly flushInterval = 5000 // 5 seconds
  private flushTimer?: NodeJS.Timeout
  private processedTracker: ProcessedMessageTracker
  private lifecycleTracker: MessageLifecycleTracker
  private databaseInitialized = false

  // Cutoff timestamp - messages before this are marked as processed but skipped
  private messageCutoffTimestamp: Date | null

  private readonly maxConcurrentLLMCalls: number
  private readonly maxQueuedMessages: number
  private readonly messageRateLimit: number
  private readonly llmCallTimeoutMs: number
  private readonly messageRateWindowMs = 60_000

  private activeLLMCalls = 0
  private llmCallsInFlight = new Set<string>()
  private llmCallTimeouts: Map<string, NodeJS.Timeout> = new Map()
  private messageTimestamps: number[] = []
  private errorTimestamps: number[] = []
  private responseTimes: number[] = []

  // Subscription health monitoring - tracks when each store last received a subscription callback
  private lastSubscriptionUpdate: Map<string, Date> = new Map()
  // Track when monitoring started for each store - used to detect subscriptions that never receive updates
  private monitoringStartTime: Map<string, Date> = new Map()
  private readonly subscriptionHealthThresholdMs: number
  // Store reference to reconnection handler so it can be removed on shutdown
  private reconnectionHandler:
    | ((data: { storeId: string; store: any }) => void | Promise<void>)
    | null = null
  // Flag to prevent operations after shutdown
  private isShutdown = false
  private readonly piBaseDir: string
  private readonly piModel: Model<any> | undefined
  private readonly stubResponder: ((message: string) => string) | null
  private readonly llmProviderMode: 'pi' | 'stub' | 'braintrust'
  private readonly braintrustBaseUrl: string | null
  private readonly braintrustProjectId: string | null
  private readonly inputValidator: PiInputValidator
  private readonly maxPiSessionsPerStore: number
  private readonly piSessionIdleTtlMs: number
  private readonly piAgentResourcesByStore: Map<string, PiAgentResources> = new Map()
  private readonly piAgentResourceInitPromises: Map<string, Promise<PiAgentResources>> = new Map()

  // Tables to monitor for activity
  // IMPORTANT: Only monitor chatMessages to process incoming user/system messages
  // Monitoring other tables is unnecessary and causes performance issues
  private readonly monitoredTables = ['chatMessages'] as const

  constructor(storeManager: StoreManager) {
    this.storeManager = storeManager
    this.processedTracker = new ProcessedMessageTracker()
    this.lifecycleTracker = getMessageLifecycleTracker()
    this.startFlushTimer()

    // Listen for store reconnection events to re-subscribe
    this.setupStoreReconnectionHandler()

    const parsePositiveInt = (
      value: string | undefined,
      fallback: number,
      allowZero = false
    ): number => {
      if (!value) return fallback
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed)) {
        return fallback
      }
      if (parsed > 0) {
        return parsed
      }
      if (allowZero && parsed === 0) {
        return 0
      }
      return fallback
    }

    this.maxConcurrentLLMCalls = parsePositiveInt(process.env.MAX_CONCURRENT_LLM_CALLS, 10, true)
    this.maxQueuedMessages = parsePositiveInt(process.env.MAX_QUEUED_MESSAGES, 0, true)
    this.messageRateLimit = parsePositiveInt(process.env.MESSAGE_RATE_LIMIT, 0, true)
    this.llmCallTimeoutMs = parsePositiveInt(process.env.LLM_CALL_TIMEOUT, 30_000, true)
    // Default 5 minutes - if no subscription callback for this long, consider connection unhealthy
    this.subscriptionHealthThresholdMs = parsePositiveInt(
      process.env.SUBSCRIPTION_HEALTH_THRESHOLD_MS,
      5 * 60 * 1000,
      true
    )
    this.maxPiSessionsPerStore = parsePositiveInt(process.env.PI_MAX_SESSIONS_PER_STORE, 200, true)
    this.piSessionIdleTtlMs = parsePositiveInt(
      process.env.PI_SESSION_IDLE_TTL_MS,
      30 * 60 * 1000,
      true
    )

    const renderDiskPath = process.env.RENDER_DISK_PATH
    this.piBaseDir =
      process.env.PI_STORAGE_DIR ||
      (renderDiskPath ? path.join(renderDiskPath, 'lifebuild-pi') : path.join(process.cwd(), '.pi'))

    const llmProvider = process.env.LLM_PROVIDER?.toLowerCase()
    this.inputValidator = new PiInputValidator()

    if (llmProvider === 'stub') {
      this.llmProviderMode = 'stub'
      this.piModel = undefined
      this.stubResponder = createStubResponder()
      this.braintrustBaseUrl = null
      this.braintrustProjectId = null
      logger.info('LLM stub responder configured for Pi integration')
    } else if (llmProvider === 'braintrust') {
      this.llmProviderMode = 'braintrust'
      this.stubResponder = null

      const baseModel = getModel('openai', 'gpt-4o-mini')
      const configuredModelId = process.env.BRAINTRUST_MODEL?.trim() || 'gpt-4o-mini'
      const configuredBaseUrl =
        process.env.BRAINTRUST_BASE_URL?.trim() || 'https://api.braintrust.dev/v1/proxy'
      const configuredProjectId = process.env.BRAINTRUST_PROJECT_ID?.trim()

      if (!baseModel) {
        this.piModel = undefined
        logger.error(
          {
            requestedModel: configuredModelId,
          },
          'Unable to initialize Braintrust model because OpenAI base model is unavailable'
        )
      } else {
        const baseHeaders = baseModel.headers ?? {}
        const braintrustHeaders = configuredProjectId
          ? { ...baseHeaders, 'x-bt-parent': `project_id:${configuredProjectId}` }
          : baseHeaders
        const braintrustCompat = {
          ...(baseModel.compat ?? {}),
          supportsStore: false,
          maxTokensField: 'max_tokens' as const,
        }

        this.piModel = {
          ...baseModel,
          provider: 'braintrust',
          api: 'openai-completions',
          id: configuredModelId,
          name: `Braintrust (${configuredModelId})`,
          baseUrl: configuredBaseUrl,
          headers: braintrustHeaders,
          compat: braintrustCompat,
        }
      }

      this.braintrustBaseUrl = configuredBaseUrl
      this.braintrustProjectId =
        configuredProjectId && configuredProjectId.length > 0 ? configuredProjectId : null

      if (!process.env.BRAINTRUST_API_KEY) {
        logger.warn(
          'LLM_PROVIDER=braintrust is set but BRAINTRUST_API_KEY is missing; Pi prompts will fail until configured'
        )
      }
      if (!configuredProjectId) {
        logger.warn(
          'LLM_PROVIDER=braintrust is set but BRAINTRUST_PROJECT_ID is missing; requests will run without project attribution'
        )
      }

      if (this.piModel) {
        logger.info(
          {
            model: this.piModel.id,
            baseUrl: configuredBaseUrl,
            projectIdConfigured: Boolean(configuredProjectId),
          },
          'Braintrust model configured for Pi agent sessions'
        )
      }
    } else {
      this.llmProviderMode = 'pi'
      this.piModel = getModel('anthropic', 'claude-opus-4-5')
      this.stubResponder = null
      this.braintrustBaseUrl = null
      this.braintrustProjectId = null

      if (llmProvider && llmProvider !== 'pi') {
        logger.warn(
          { llmProvider },
          'Unknown LLM_PROVIDER value for Pi integration, defaulting to Anthropic Pi model'
        )
      }

      if (!this.piModel) {
        logger.error(
          { model: 'claude-opus-4-5' },
          'Pi model not available - LLM functionality disabled'
        )
      } else {
        logger.info({ model: this.piModel.id }, 'Pi model configured for agent sessions')
      }
    }

    logger.info(
      {
        maxPiSessionsPerStore:
          this.maxPiSessionsPerStore > 0 ? this.maxPiSessionsPerStore : 'unbounded',
        piSessionIdleTtlMs: this.piSessionIdleTtlMs > 0 ? this.piSessionIdleTtlMs : 'disabled',
      },
      'Pi session cache configuration'
    )

    // Load message cutoff timestamp from environment
    const cutoffEnv = process.env.MESSAGE_PROCESSING_CUTOFF_TIMESTAMP
    this.messageCutoffTimestamp = cutoffEnv ? new Date(cutoffEnv) : null
    if (this.messageCutoffTimestamp) {
      logger.info(
        { cutoffTimestamp: this.messageCutoffTimestamp.toISOString() },
        'Message processing cutoff configured'
      )
    }

    // Initialize processed message tracking
    this.processedTracker
      .initialize()
      .then(() => {
        this.databaseInitialized = true
        logger.info('Processed message tracking initialized')
      })
      .catch(error => {
        logger.error(
          { error },
          'CRITICAL: Failed to initialize processed message tracker, stopping all message processing'
        )
        this.databaseInitialized = false
      })
  }

  async startMonitoring(storeId: string, store: LiveStore): Promise<void> {
    storeLogger(storeId).info('Starting comprehensive event monitoring')
    const telemetry = createOrchestrationTelemetry({
      operation: 'event_processor.start_monitoring',
      storeId,
    })

    const existingState = this.storeStates.get(storeId)
    if (existingState) {
      if (existingState.stopping) {
        storeLogger(storeId).warn('Store is currently stopping, cannot start monitoring')
      } else {
        storeLogger(storeId).warn('Store is already being monitored')
      }
      telemetry.recordSuccess({
        status: existingState.stopping ? 'stopping' : 'already_monitoring',
      })
      return
    }

    // Initialize processing state for this store
    const storeState: StoreProcessingState = {
      subscriptions: [],
      eventBuffer: {
        events: [],
        lastFlushed: new Date(),
        processing: false,
      },
      errorCount: 0,
      processingQueue: Promise.resolve(),
      stopping: false,
      activeConversations: new Set(),
      messageQueue: new MessageQueueManager(),
      conversationProcessors: new Map(),
      piSessions: new Map(),
    }

    this.storeStates.set(storeId, storeState)

    // Record when monitoring started - used to detect subscriptions that never receive updates
    this.monitoringStartTime.set(storeId, new Date())

    storeLogger(storeId).debug('Using persistent message tracking')

    // Monitor all important tables
    let successfulSubscriptions = 0
    for (const tableName of this.monitoredTables) {
      if (this.setupTableSubscription(storeId, store, tableName, storeState)) {
        successfulSubscriptions += 1
      }
    }

    if (successfulSubscriptions > 0) {
      const { durationMs } = telemetry.recordSuccess({
        status: 'monitoring_started',
        subscriptions: successfulSubscriptions,
      })
      storeLogger(storeId).info(
        {
          status: 'monitoring_started',
          durationMs,
          subscriptions: successfulSubscriptions,
          incidentDashboardUrl: getIncidentDashboardUrl(),
        },
        'Event monitoring ready'
      )
    } else {
      // Clean up resources before throwing - the state was already added to the map
      // Set stopping flag for consistency with other cleanup paths
      storeState.stopping = true
      storeState.messageQueue.destroy()
      await this.disposePiSessions(storeId, storeState)
      this.clearPiAgentResources(storeId)
      this.storeStates.delete(storeId)
      this.monitoringStartTime.delete(storeId)

      const failure = new Error('Failed to create any subscriptions')
      const { durationMs } = telemetry.recordFailure(failure, {
        status: 'no_subscriptions',
      })
      storeLogger(storeId).error(
        {
          durationMs,
          incidentDashboardUrl: getIncidentDashboardUrl(),
        },
        'Failed to start event monitoring'
      )
      throw failure
    }
  }

  private setupTableSubscription(
    storeId: string,
    store: LiveStore,
    tableName: string,
    storeState: StoreProcessingState
  ): boolean {
    try {
      // We only monitor chatMessages now for processing incoming chat turns
      if (tableName !== 'chatMessages') {
        logger.warn(`Unexpected table ${tableName} - only chatMessages should be monitored`)
        return false
      }

      // Subscribe to chatMessages table with recent filter to reduce volume
      // Still get all matching records on each update, but limit scope to reduce load
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      const query = queryDb(tables.chatMessages.select().where('createdAt', '>=', oneHourAgo), {
        label: `monitor-${tableName}-${storeId}`,
      })

      const unsubscribe = store.subscribe(query as any, (records: any[]) => {
        this.handleTableUpdate(storeId, tableName, records, storeState)
      })

      storeState.subscriptions.push(unsubscribe)
      storeLogger(storeId).debug({ tableName }, 'Subscribed to table')
      return true
    } catch (error) {
      storeLogger(storeId).error({ error, tableName }, `Failed to subscribe to ${tableName}`)
      this.incrementErrorCount(storeId, error as Error)
      return false
    }
  }

  private handleTableUpdate(
    storeId: string,
    tableName: string,
    records: unknown[],
    storeState: StoreProcessingState
  ): void {
    // Skip processing if store is stopping
    if (storeState.stopping) {
      return
    }

    // Track subscription health - record that we received a callback
    this.lastSubscriptionUpdate.set(storeId, new Date())

    // Update activity tracker
    this.storeManager.updateActivity(storeId)

    // Only handle chatMessages table (our focus)
    if (tableName !== 'chatMessages') {
      return
    }

    // Filter for incoming user/system messages only.
    // System messages are used for internal bootstrap turns that should still trigger the agent loop.
    const incomingRecords = records.filter(
      (record: any) =>
        record && typeof record === 'object' && (record.role === 'user' || record.role === 'system')
    )

    if (incomingRecords.length === 0) {
      return
    }

    const log = createContextLogger({ storeId, operation: 'buffer_messages' })
    log.info({ messageCount: incomingRecords.length }, 'Buffering incoming messages for processing')

    // Convert records to ProcessedEvent objects for buffering
    // Start lifecycle tracking for each message
    const events: ProcessedEvent[] = incomingRecords.map((record: any) => {
      // Start tracking this message's lifecycle
      const { correlationId } = this.lifecycleTracker.startTracking(
        record.id,
        storeId,
        record.conversationId
      )

      logMessageEvent(
        'info',
        {
          correlationId,
          messageId: record.id,
          storeId,
          conversationId: record.conversationId,
          stage: 'event_processor',
          action: 'message_received',
        },
        'Incoming chat message received'
      )

      return {
        type: 'chatMessage',
        storeId,
        data: record,
        timestamp: new Date(),
      }
    })

    // Record buffering for each message
    for (const event of events) {
      const record = event.data as any
      this.lifecycleTracker.recordBuffered(
        record.id,
        storeState.eventBuffer.events.length + events.length
      )
    }

    // Buffer events for async processing (uses existing event pipeline)
    this.bufferEvents(storeId, events, storeState)
  }

  private async processChatMessage(
    storeId: string,
    message: ChatMessage,
    storeState: StoreProcessingState
  ): Promise<void> {
    const messagePreview =
      message.message?.slice(0, 50) + (message.message?.length > 50 ? '...' : '')
    const correlationId = this.lifecycleTracker.getCorrelationId(message.id)
    const log = createContextLogger({
      messageId: message.id,
      conversationId: message.conversationId,
      correlationId,
    })
    log.info({ messagePreview }, 'Processing chat message')

    // CRITICAL: If database is not initialized, stop all processing to prevent infinite loops
    if (!this.databaseInitialized) {
      logger.error(
        { messageId: message.id, correlationId },
        `CRITICAL: Database not initialized - SKIPPING message to prevent duplicate processing. Fix database initialization issue and restart server`
      )
      this.lifecycleTracker.recordError(message.id, 'Database not initialized', 'DB_NOT_INIT')
      return
    }

    try {
      // Check if already processed using SQLite
      const isAlreadyProcessed = await this.processedTracker.isProcessed(message.id, storeId)

      if (isAlreadyProcessed) {
        log.debug('Message already processed, skipping LLM call')
        this.lifecycleTracker.recordDedupeChecked(message.id, true, 'already_processed')
        return
      }

      // Check if message is before cutoff timestamp
      if (this.messageCutoffTimestamp && message.createdAt) {
        const messageDate = new Date(message.createdAt)
        if (messageDate < this.messageCutoffTimestamp) {
          logger.info(
            { messageId: message.id, messageDate: messageDate.toISOString(), correlationId },
            `Message before cutoff - no LLM call`
          )
          this.lifecycleTracker.recordDedupeChecked(message.id, true, 'before_cutoff')
          // Mark as processed in SQLite but don't actually process it
          await this.processedTracker.markProcessed(message.id, storeId)
          return
        }
      }

      // Record dedupe check passed
      this.lifecycleTracker.recordDedupeChecked(message.id, false)

      // Attempt to claim processing rights atomically
      const claimedProcessing = await this.processedTracker.markProcessed(message.id, storeId)

      if (!claimedProcessing) {
        logger.info(
          { messageId: message.id, correlationId },
          `Another instance claimed processing for message - no LLM call`
        )
        this.lifecycleTracker.recordDedupeChecked(message.id, true, 'claimed_by_other_instance')
        return
      }

      logMessageEvent(
        'info',
        {
          correlationId: correlationId || message.id,
          messageId: message.id,
          storeId,
          conversationId: message.conversationId,
          stage: 'event_processor',
          action: 'processing_claimed',
        },
        'Message processing claimed, sending to LLM'
      )

      // Defer processing to avoid committing during reactive update cycle
      setImmediate(() => {
        this.handleUserMessage(storeId, message, storeState)
      })
    } catch (error) {
      logger.error(
        { error, messageId: message.id, correlationId },
        `CRITICAL: Database operation failed - SKIPPING message to prevent infinite loops`
      )
      this.lifecycleTracker.recordError(
        message.id,
        error instanceof Error ? error : String(error),
        'DB_ERROR'
      )
      // DO NOT process the message - this could cause infinite loops if DB is broken
      return
    }
  }

  private bufferEvents(
    storeId: string,
    events: ProcessedEvent[],
    storeState: StoreProcessingState
  ): void {
    storeState.eventBuffer.events.push(...events)

    // If buffer is full or processing is idle, trigger processing
    if (
      storeState.eventBuffer.events.length >= this.maxBufferSize ||
      !storeState.eventBuffer.processing
    ) {
      this.scheduleEventProcessing(storeId, storeState)
    }
  }

  private scheduleEventProcessing(
    storeId: string,
    storeState: StoreProcessingState
  ): Promise<void> {
    // Chain processing to ensure serialization per store
    storeState.processingQueue = storeState.processingQueue.then(async () => {
      await this.processBufferedEvents(storeId, storeState)
    })
    return storeState.processingQueue
  }

  private async processBufferedEvents(
    storeId: string,
    storeState: StoreProcessingState
  ): Promise<void> {
    if (
      storeState.eventBuffer.processing ||
      storeState.eventBuffer.events.length === 0 ||
      storeState.stopping
    ) {
      return
    }

    storeState.eventBuffer.processing = true
    const events = [...storeState.eventBuffer.events]
    storeState.eventBuffer.events = []
    storeState.eventBuffer.lastFlushed = new Date()

    try {
      await this.handleEvents(storeId, events, storeState)
    } catch (error) {
      storeLogger(storeId).error({ error }, `Error processing buffered events`)
      this.incrementErrorCount(storeId, error as Error)
    } finally {
      storeState.eventBuffer.processing = false
    }
  }

  private async handleEvents(
    storeId: string,
    events: ProcessedEvent[],
    storeState: StoreProcessingState
  ): Promise<void> {
    for (const event of events) {
      try {
        await this.processEvent(storeId, event, storeState)
      } catch (error) {
        storeLogger(storeId).error({ error, event: event.type }, `Error processing event`)
        this.incrementErrorCount(storeId, error as Error)

        // Continue processing other events even if one fails (isolation)
        continue
      }
    }
  }

  private async processEvent(
    storeId: string,
    event: ProcessedEvent,
    storeState: StoreProcessingState
  ): Promise<void> {
    // Handle different event types
    if (event.type === 'chatMessage') {
      // Extract ChatMessage data from the event
      const chatMessage = event.data as ChatMessage

      // Process using our existing chat message logic (with SQLite deduplication)
      await this.processChatMessage(storeId, chatMessage, storeState)
    } else {
      // Log unhandled event types for future extension
      storeLogger(storeId).debug({ eventType: event.type }, `Unhandled event type`)
    }
  }

  /**
   * Handle a new user message and trigger agentic loop if needed
   */
  private async handleUserMessage(
    storeId: string,
    chatMessage: ChatMessage,
    storeState: StoreProcessingState
  ): Promise<void> {
    const { conversationId, id: messageId } = chatMessage
    const correlationId = this.lifecycleTracker.getCorrelationId(messageId)

    // Skip if Pi model is not configured (unless stub responder is enabled)
    if (!this.piModel && !this.stubResponder) {
      storeLogger(storeId).debug(`Skipping chat message processing: Pi model not configured`)
      this.lifecycleTracker.recordError(messageId, 'Pi model not configured', 'LLM_DISABLED')
      return
    }

    // Check resource limits before processing
    if (!this.canStartLLMCall()) {
      logger.warn(
        { conversationId, storeId, correlationId },
        `Rejecting LLM call: Resource limits exceeded`
      )
      this.lifecycleTracker.recordError(messageId, 'Resource limits exceeded', 'RATE_LIMITED')
      const store = this.storeManager.getStore(storeId)
      if (store) {
        store.commit(
          events.llmResponseReceived({
            id: crypto.randomUUID(),
            conversationId,
            message: 'System is currently under high load. Please try again in a moment.',
            role: 'assistant',
            modelId: 'resource-limit',
            responseToMessageId: messageId,
            createdAt: new Date(),
            llmMetadata: { source: 'resource-limit-exceeded' },
          })
        )
      }
      return
    }

    // Check if we can queue more messages
    const queueCheck = this.canAcceptIncomingMessage()
    if (!queueCheck.allowed) {
      logger.warn(
        { conversationId, reason: queueCheck.reason, correlationId },
        `Message intake limited`
      )
      this.lifecycleTracker.recordError(
        messageId,
        `Message intake limited: ${queueCheck.reason}`,
        'INTAKE_LIMITED'
      )
      return
    }

    // Track the message
    this.recordIncomingMessage()

    // Skip if this conversation is already being processed - queue the message instead
    if (storeState.activeConversations.has(conversationId)) {
      logger.debug({ conversationId, correlationId }, `Queueing message (already processing)`)

      try {
        storeState.messageQueue.enqueue(conversationId, chatMessage)
        const queuePosition = storeState.messageQueue.getQueueLength(conversationId)
        this.lifecycleTracker.recordQueued(messageId, queuePosition)
        logger.debug(
          { conversationId, queueLength: queuePosition, correlationId },
          `Message queued`
        )
      } catch (error) {
        logger.error(
          { error: this.formatErrorForLog(error), conversationId, correlationId },
          `Failed to queue message`
        )
        this.lifecycleTracker.recordError(
          messageId,
          error instanceof Error ? error : String(error),
          'QUEUE_ERROR'
        )
        // Emit error to conversation if queue is full
        const store = this.storeManager.getStore(storeId)
        if (store) {
          store.commit(
            events.llmResponseReceived({
              id: crypto.randomUUID(),
              conversationId,
              message: 'Message queue is full. Please wait before sending more messages.',
              role: 'assistant',
              modelId: 'error',
              responseToMessageId: messageId,
              createdAt: new Date(),
              llmMetadata: { source: 'queue-overflow-error' },
            })
          )
        }
      }
      return
    }

    // Record that processing is starting
    this.lifecycleTracker.recordProcessingStarted(messageId)
    logMessageEvent(
      'info',
      {
        correlationId: correlationId || messageId,
        messageId,
        storeId,
        conversationId,
        stage: 'event_processor',
        action: 'processing_started',
      },
      'Starting agentic loop for user message'
    )

    // Check conversation limits per store
    if (storeState.activeConversations.size >= 50) {
      storeLogger(storeId).warn(`Too many active conversations`)
      this.lifecycleTracker.recordError(
        messageId,
        `Too many active conversations (${storeState.activeConversations.size}/50)`,
        'CONVERSATION_LIMIT'
      )
      return
    }

    // Mark conversation as active
    storeState.activeConversations.add(conversationId)

    // Track LLM call start
    const llmCallId = this.beginLLMCall()

    // Emit response started event (safe now that we defer processing)
    const store = this.storeManager.getStore(storeId)
    if (store) {
      store.commit(
        events.llmResponseStarted({
          conversationId,
          userMessageId: messageId,
          createdAt: new Date(),
        })
      )
    }

    let llmCallCompleted = false
    let agentRunSucceeded = false
    try {
      const startTime = Date.now()
      agentRunSucceeded = await this.runAgenticLoop(storeId, chatMessage, storeState)
      const responseTime = Date.now() - startTime

      if (!agentRunSucceeded) {
        this.endLLMCall(llmCallId, true)
        llmCallCompleted = true
        this.lifecycleTracker.recordError(
          messageId,
          'Agentic loop reported failure during processing',
          'AGENTIC_LOOP_FAILED'
        )
        logMessageEvent(
          'warn',
          {
            correlationId: correlationId || messageId,
            messageId,
            storeId,
            conversationId,
            stage: 'event_processor',
            action: 'processing_failed',
          },
          'Message processing failed'
        )
      } else {
        // Track successful completion
        this.endLLMCall(llmCallId, false, responseTime)
        llmCallCompleted = true

        // Record lifecycle completion
        this.lifecycleTracker.recordCompleted(messageId)
        logMessageEvent(
          'info',
          {
            correlationId: correlationId || messageId,
            messageId,
            storeId,
            conversationId,
            stage: 'event_processor',
            action: 'processing_completed',
            durationMs: responseTime,
          },
          'Message processing completed successfully'
        )
      }
    } catch (error) {
      // Track error and ensure LLM call is properly cleaned up
      this.recordError()
      if (!llmCallCompleted) {
        this.endLLMCall(llmCallId, true) // Mark as timeout/error
      }
      logger.error(
        { error: this.formatErrorForLog(error), conversationId, correlationId },
        `Error in agentic loop`
      )

      // Record lifecycle error
      this.lifecycleTracker.recordError(
        messageId,
        error instanceof Error ? error : String(error),
        'AGENTIC_LOOP_ERROR'
      )

      // Emit error message to conversation
      if (store) {
        store.commit(
          events.llmResponseReceived({
            id: crypto.randomUUID(),
            conversationId,
            message: 'Sorry, I encountered an error processing your message. Please try again.',
            role: 'assistant',
            modelId: 'error',
            responseToMessageId: messageId,
            createdAt: new Date(),
            llmMetadata: { source: 'error' },
          })
        )
        store.commit(
          events.llmResponseCompleted({
            conversationId,
            userMessageId: messageId,
            createdAt: new Date(),
            iterations: 0,
            success: false,
          })
        )
      }
    } finally {
      // Ensure LLM call is always cleaned up
      if (!llmCallCompleted) {
        this.endLLMCall(llmCallId, true)
      }

      // Always remove from active conversations
      storeState.activeConversations.delete(conversationId)
    }

    // Process any queued messages for this conversation (outside try/catch to avoid recursion)
    await this.processQueuedMessages(storeId, conversationId, storeState)
  }

  /**
   * Process a single queued message without recursive queue processing
   */
  private async processQueuedMessage(
    storeId: string,
    chatMessage: ChatMessage,
    storeState: StoreProcessingState
  ): Promise<void> {
    const conversationId = chatMessage.conversationId
    const messageId = chatMessage.id
    const correlationId = this.lifecycleTracker.getCorrelationId(messageId) || messageId

    logger.info({ conversationId, correlationId }, `Processing queued message`)

    // Record that processing is starting for queued message
    this.lifecycleTracker.recordProcessingStarted(messageId)
    logMessageEvent(
      'info',
      {
        correlationId,
        messageId,
        storeId,
        conversationId,
        stage: 'event_processor',
        action: 'processing_started_queued',
      },
      'Starting agentic loop for queued user message'
    )

    // Check conversation limits per store
    if (storeState.activeConversations.size >= 50) {
      storeLogger(storeId).warn(`Too many active conversations`)
      this.lifecycleTracker.recordError(
        messageId,
        'Too many active conversations while dequeuing',
        'ACTIVE_CONVERSATION_LIMIT'
      )
      return
    }

    // Mark conversation as active
    storeState.activeConversations.add(conversationId)

    // Track LLM call start
    const llmCallId = this.beginLLMCall()

    // Emit response started event
    const store = this.storeManager.getStore(storeId)
    if (store) {
      store.commit(
        events.llmResponseStarted({
          conversationId,
          userMessageId: messageId,
          createdAt: new Date(),
        })
      )
    }

    let llmCallCompleted = false
    let agentRunSucceeded = false
    try {
      const startTime = Date.now()
      agentRunSucceeded = await this.runAgenticLoop(storeId, chatMessage, storeState)
      const responseTime = Date.now() - startTime

      if (!agentRunSucceeded) {
        this.endLLMCall(llmCallId, true)
        llmCallCompleted = true
        this.lifecycleTracker.recordError(
          messageId,
          'Agentic loop reported failure during queued message processing',
          'AGENTIC_LOOP_FAILED'
        )
        logMessageEvent(
          'warn',
          {
            correlationId,
            messageId,
            storeId,
            conversationId,
            stage: 'event_processor',
            action: 'processing_failed_queued',
          },
          'Queued message processing failed'
        )
        return
      } else {
        // Track successful completion
        this.endLLMCall(llmCallId, false, responseTime)
        llmCallCompleted = true

        // Record lifecycle completion and log correlated event
        this.lifecycleTracker.recordCompleted(messageId)
        logMessageEvent(
          'info',
          {
            correlationId,
            messageId,
            storeId,
            conversationId,
            stage: 'event_processor',
            action: 'processing_completed_queued',
            durationMs: responseTime,
          },
          'Queued message processed successfully'
        )
      }
    } catch (error) {
      // Track error and ensure LLM call is properly cleaned up
      this.recordError()
      if (!llmCallCompleted) {
        this.endLLMCall(llmCallId, true) // Mark as timeout/error
      }
      logger.error(
        { error: this.formatErrorForLog(error), conversationId, correlationId },
        `Error in agentic loop`
      )

      // Record lifecycle error
      this.lifecycleTracker.recordError(
        messageId,
        error instanceof Error ? error : String(error),
        'AGENTIC_LOOP_ERROR'
      )

      logMessageEvent(
        'error',
        {
          correlationId,
          messageId,
          storeId,
          conversationId,
          stage: 'event_processor',
          action: 'processing_error_queued',
          error: error instanceof Error ? error.message : String(error),
        },
        'Queued message processing failed'
      )

      // Emit error message to conversation
      if (store) {
        store.commit(
          events.llmResponseReceived({
            id: crypto.randomUUID(),
            conversationId,
            message: 'Sorry, I encountered an error processing your message. Please try again.',
            role: 'assistant',
            modelId: 'error',
            responseToMessageId: messageId,
            createdAt: new Date(),
            llmMetadata: { source: 'error' },
          })
        )
        store.commit(
          events.llmResponseCompleted({
            conversationId,
            userMessageId: messageId,
            createdAt: new Date(),
            iterations: 0,
            success: false,
          })
        )
      }
    } finally {
      // Ensure LLM call is always cleaned up
      if (!llmCallCompleted) {
        this.endLLMCall(llmCallId, true)
      }

      // Always remove from active conversations
      storeState.activeConversations.delete(conversationId)
    }

    // NOTE: Deliberately NOT calling processQueuedMessages here to avoid recursion
  }

  private async runStubResponder(
    store: LiveStore,
    userMessage: ChatMessage,
    prompt: string
  ): Promise<boolean> {
    const message = this.stubResponder?.(prompt) ?? ''
    const conversationId = userMessage.conversationId

    store.commit(
      events.llmResponseReceived({
        id: crypto.randomUUID(),
        conversationId,
        message,
        role: 'assistant',
        modelId: 'stub',
        responseToMessageId: userMessage.id,
        createdAt: new Date(),
        llmMetadata: { source: 'stub' },
      })
    )

    store.commit(
      events.llmResponseCompleted({
        conversationId,
        userMessageId: userMessage.id,
        createdAt: new Date(),
        iterations: 1,
        success: true,
      })
    )

    return true
  }

  /**
   * Run the agentic loop for a user message
   */
  private async runAgenticLoop(
    storeId: string,
    userMessage: ChatMessage,
    storeState: StoreProcessingState
  ): Promise<boolean> {
    const store = this.storeManager.getStore(storeId)
    if (!store) {
      return false
    }

    const validationResult = this.inputValidator.validateUserMessage(userMessage.message ?? '')
    if (!validationResult.isValid) {
      logger.warn(
        {
          storeId,
          conversationId: userMessage.conversationId,
          userMessageId: userMessage.id,
          reason: validationResult.reason,
        },
        'Blocked user message due to input validation failure'
      )

      store.commit(
        events.llmResponseReceived({
          id: crypto.randomUUID(),
          conversationId: userMessage.conversationId,
          message:
            'I could not process that request safely. Please rephrase and try again without special instruction overrides.',
          role: 'assistant',
          modelId: 'error',
          responseToMessageId: userMessage.id,
          createdAt: new Date(),
          llmMetadata: {
            source: 'input-validation-error',
            reason: validationResult.reason ?? 'unknown',
          },
        })
      )

      store.commit(
        events.llmResponseCompleted({
          conversationId: userMessage.conversationId,
          userMessageId: userMessage.id,
          createdAt: new Date(),
          iterations: 0,
          success: false,
        })
      )

      return false
    }

    const sanitizedPrompt = validationResult.sanitizedContent ?? userMessage.message ?? ''
    if (sanitizedPrompt !== (userMessage.message ?? '')) {
      logger.debug(
        {
          storeId,
          conversationId: userMessage.conversationId,
          userMessageId: userMessage.id,
          originalLength: (userMessage.message ?? '').length,
          sanitizedLength: sanitizedPrompt.length,
        },
        'Sanitized user input before invoking LLM provider'
      )
    }

    if (this.stubResponder) {
      return this.runStubResponder(store, userMessage, sanitizedPrompt)
    }

    if (!this.piModel) {
      return false
    }

    // Get conversation details, worker context, and history
    let conversation: any, worker: any, chatHistory: ChatMessage[]
    try {
      // Get conversation
      const conversationResult = store.query(
        queryDb(tables.conversations.select().where('id', '=', userMessage.conversationId))
      )
      conversation = conversationResult[0]

      // Get worker if conversation has workerId
      if (conversation?.workerId) {
        const workerResult = store.query(
          queryDb(tables.workers.select().where('id', '=', conversation.workerId))
        )
        worker = workerResult[0]
      }

      // Get chat history
      chatHistory = store.query(
        queryDb(
          tables.chatMessages
            .select()
            .where('conversationId', '=', userMessage.conversationId)
            .orderBy('createdAt', 'asc')
        )
      )
    } catch (error) {
      logger.error({ error: this.formatErrorForLog(error) }, `Error querying conversation context`)
      // If we can't get the context due to store issues, bail out gracefully
      store.commit(
        events.llmResponseReceived({
          id: crypto.randomUUID(),
          conversationId: userMessage.conversationId,
          message: 'I had trouble loading the conversation context. Please try again.',
          role: 'assistant',
          modelId: 'error',
          responseToMessageId: userMessage.id,
          createdAt: new Date(),
          llmMetadata: { source: 'context-load-error' },
        })
      )

      store.commit(
        events.llmResponseCompleted({
          conversationId: userMessage.conversationId,
          userMessageId: userMessage.id,
          createdAt: new Date(),
          iterations: 0,
          success: false,
        })
      )

      return false
    }

    let workerContext: WorkerContext | undefined = undefined
    let navigationContext: NavigationContext | undefined = undefined

    // Resolve prompt from room definition (code) instead of worker.systemPrompt (DB)
    // This ensures prompts are always up-to-date with code changes
    let resolvedPrompt: string | undefined
    let resolvedName: string | undefined
    let resolvedRoleDescription: string | undefined

    if (conversation?.roomId) {
      const roomDef = getRoomDefinitionByRoomId(conversation.roomId)

      if (roomDef) {
        // Static room - use code-defined prompt
        resolvedPrompt = roomDef.worker.prompt
        resolvedName = roomDef.worker.name
        resolvedRoleDescription = roomDef.worker.roleDescription
      } else if (conversation.roomId.startsWith('project:')) {
        // Dynamic project room - build from project data
        const projectId = conversation.roomId.replace('project:', '')
        const projects = store.query(queryDb(tables.projects.select().where('id', '=', projectId)))
        const project = projects[0]
        if (project) {
          // Resolve lifecycle state from projectLifecycleState or fall back to legacy attributes
          // This ensures legacy projects (created before lifecycle migration) still get proper planning context
          const lifecycleState = resolveLifecycleState(
            project.projectLifecycleState,
            project.attributes as PlanningAttributes | null
          )

          // Convert to PlanningAttributes format (null → undefined for type compatibility)
          const attributes = {
            status: lifecycleState.status,
            planningStage: lifecycleState.stage,
            objectives: lifecycleState.objectives ?? undefined,
            deadline: lifecycleState.deadline ?? undefined,
            archetype: lifecycleState.archetype ?? undefined,
            estimatedDuration: lifecycleState.estimatedDuration ?? undefined,
            urgency: lifecycleState.urgency ?? undefined,
            importance: lifecycleState.importance ?? undefined,
            complexity: lifecycleState.complexity ?? undefined,
            scale: lifecycleState.scale ?? undefined,
            priority: lifecycleState.priority ?? undefined,
            activatedAt: lifecycleState.activatedAt ?? undefined,
          }

          const projectRoomParams: ProjectRoomParameters = {
            projectId: project.id,
            name: project.name,
            description: project.description,
            objectives: lifecycleState.objectives ?? undefined,
            archivedAt: project.archivedAt ? project.archivedAt.getTime() : null,
            deletedAt: project.deletedAt ? project.deletedAt.getTime() : null,
            attributes,
          }
          const projectRoomDef = createProjectRoomDefinition(projectRoomParams)
          resolvedPrompt = projectRoomDef.worker.prompt
          resolvedName = projectRoomDef.worker.name
          resolvedRoleDescription = projectRoomDef.worker.roleDescription
        }
      }
    }

    // Build worker context - prefer resolved prompt from code, fall back to DB for custom workers
    if (resolvedPrompt || worker) {
      workerContext = {
        systemPrompt: resolvedPrompt ?? worker?.systemPrompt ?? '',
        name: resolvedName ?? worker?.name ?? 'Assistant',
        roleDescription: resolvedRoleDescription ?? (worker?.roleDescription || undefined),
      }
    }

    // Extract and enrich navigation context from user message
    if (userMessage.navigationContext) {
      try {
        const parsedContext = JSON.parse(userMessage.navigationContext)
        navigationContext = await this.enrichNavigationContext(store, parsedContext)
        logger.debug({ navigationContext }, 'Enriched navigation context')
      } catch (error) {
        logger.warn(
          { error: this.formatErrorForLog(error) },
          'Failed to parse/enrich navigation context from user message'
        )
      }
    }

    // Convert chat messages to conversation history format and sanitize tool calls.
    // The conversation history intentionally excludes the live user message because the agentic
    // loop appends it before contacting the provider.
    const conversationHistory = this.buildConversationHistory(chatHistory, userMessage)

    const conversationId = userMessage.conversationId
    const correlationId = this.lifecycleTracker.getCorrelationId(userMessage.id)
    const sessionEntry = await this.getOrCreatePiSession(
      storeId,
      conversationId,
      storeState,
      store,
      worker?.id
    )
    if (!sessionEntry) {
      logger.error(
        { storeId, conversationId, correlationId },
        'Pi session initialization failed before prompt execution'
      )
      store.commit(
        events.llmResponseReceived({
          id: crypto.randomUUID(),
          conversationId,
          message: 'Sorry, I could not start the assistant session. Please try again.',
          role: 'assistant',
          modelId: 'error',
          responseToMessageId: userMessage.id,
          createdAt: new Date(),
          llmMetadata: { source: 'session-init-error' },
        })
      )
      store.commit(
        events.llmResponseCompleted({
          conversationId,
          userMessageId: userMessage.id,
          createdAt: new Date(),
          iterations: 0,
          success: false,
        })
      )
      return false
    }

    const { session } = sessionEntry
    const modelId = this.piModel?.id || conversation?.model || DEFAULT_MODEL

    session.agent.state.systemPrompt = buildSystemPrompt(workerContext, navigationContext)

    if (session.agent.state.messages.length === 0 && conversationHistory.length > 0) {
      session.agent.state.messages = conversationHistory
    }

    // Snapshot message count before prompting so we can distinguish current-run
    // output from historical messages already present in the session.
    const promptStartMessageCount = session.agent.state.messages.length

    let sawError = false
    let promptErrorCaptured = false
    let iterationCount = 0
    let assistantResponseEmitted = false
    let anyResponseEmitted = false
    let failureContext: Record<string, unknown> | undefined
    let latestAssistantText = ''
    let assistantMessageEventCount = 0
    let sawAssistantMessageEndText = false

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (storeState.stopping) {
        return
      }

      switch (event.type) {
        case 'tool_execution_start': {
          // Suppress tool progress chatter in the chat transcript.
          break
        }
        case 'tool_execution_end': {
          const formatted =
            typeof event.result?.details?.formatted === 'string'
              ? event.result.details.formatted
              : this.extractToolResultText(event.result?.content)

          // Only surface tool output when the tool failed.
          if (formatted && event.isError) {
            store.commit(
              events.llmResponseReceived({
                id: crypto.randomUUID(),
                conversationId,
                message: formatted,
                role: 'assistant',
                modelId: 'system',
                responseToMessageId: userMessage.id,
                createdAt: new Date(),
                llmMetadata: {
                  source: 'tool-error',
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                },
              })
            )
            anyResponseEmitted = true
          }
          break
        }
        case 'turn_end': {
          iterationCount += 1
          break
        }
        case 'message_end': {
          if (event.message.role === 'assistant') {
            if (this.isAssistantErrorMessage(event.message)) {
              sawError = true
              failureContext = {
                source: 'message_end',
                stopReason: event.message.stopReason,
                errorMessage:
                  'errorMessage' in event.message ? (event.message.errorMessage ?? null) : null,
              }
            }

            const text = this.extractAssistantText(event.message)
            if (text.trim().length > 0) {
              latestAssistantText = text
              assistantMessageEventCount += 1
              sawAssistantMessageEndText = true
            }
          }
          break
        }
        case 'agent_end': {
          const currentRunMessages = event.messages.slice(promptStartMessageCount)
          const latestAssistantMessage = [...currentRunMessages]
            .reverse()
            .find((message): message is AssistantMessage => message.role === 'assistant')
          if (latestAssistantMessage && this.isAssistantErrorMessage(latestAssistantMessage)) {
            sawError = true
            failureContext = {
              source: 'agent_end',
              stopReason: latestAssistantMessage.stopReason,
              errorMessage:
                'errorMessage' in latestAssistantMessage
                  ? (latestAssistantMessage.errorMessage ?? null)
                  : null,
            }
          }
          if (latestAssistantMessage && !sawAssistantMessageEndText) {
            const latestText = this.extractAssistantText(latestAssistantMessage).trim()
            if (latestText.length > 0) {
              latestAssistantText = latestText
            }
          }
          break
        }
        default:
          break
      }
    })

    try {
      await session.setModel(this.piModel)
      await session.prompt(sanitizedPrompt)
    } catch (error) {
      sawError = true
      promptErrorCaptured = true
      failureContext = {
        source: 'prompt_exception',
        error: this.formatErrorForLog(error),
      }
      logger.error(
        { error: this.formatErrorForLog(error), conversationId, correlationId },
        'Error in Pi agent session'
      )
      this.captureAgentError(error, {
        storeId,
        conversationId,
        userMessageId: userMessage.id,
        correlationId,
        stage: 'prompt_execution',
      })
    } finally {
      unsubscribe()
    }

    const finalAssistantText = latestAssistantText.trim()
    if (storeState.stopping) {
      if (finalAssistantText.length > 0) {
        logger.info(
          { storeId, conversationId, userMessageId: userMessage.id },
          'Skipping assistant response emission because store is stopping'
        )
      }
    } else if (!assistantResponseEmitted && finalAssistantText.length > 0) {
      if (assistantMessageEventCount > 1) {
        logger.info(
          {
            storeId,
            conversationId,
            userMessageId: userMessage.id,
            assistantMessageEventCount,
          },
          'Collapsing multiple Pi assistant message_end events into a single response'
        )
      }

      store.commit(
        events.llmResponseReceived({
          id: crypto.randomUUID(),
          conversationId,
          message: finalAssistantText,
          role: 'assistant',
          modelId,
          responseToMessageId: userMessage.id,
          createdAt: new Date(),
          llmMetadata: {
            source: 'pi',
            messageType: 'assistant',
          },
        })
      )
      assistantResponseEmitted = true
      anyResponseEmitted = true
    }

    if (sawError && !assistantResponseEmitted) {
      if (storeState.stopping) {
        logger.info(
          { storeId, conversationId, userMessageId: userMessage.id },
          'Skipping fallback error response because store is stopping'
        )
      } else if (anyResponseEmitted) {
        logger.info(
          { storeId, conversationId, userMessageId: userMessage.id },
          'Skipping fallback error response because a response was already emitted'
        )
      } else {
        logger.warn(
          {
            storeId,
            conversationId,
            correlationId,
            userMessageId: userMessage.id,
            failureContext,
          },
          'Pi session reported an error state without assistant text; emitting fallback error response'
        )
        store.commit(
          events.llmResponseReceived({
            id: crypto.randomUUID(),
            conversationId,
            message: 'Sorry, I encountered an error processing your message. Please try again.',
            role: 'assistant',
            modelId: 'error',
            responseToMessageId: userMessage.id,
            createdAt: new Date(),
            llmMetadata: { source: 'error' },
          })
        )
        assistantResponseEmitted = true
        anyResponseEmitted = true
      }
    }

    if (sawError && !promptErrorCaptured) {
      this.captureAgentError(
        new Error('Pi session ended with non-throwing error state', {
          cause: failureContext,
        }),
        {
          storeId,
          conversationId,
          userMessageId: userMessage.id,
          correlationId,
          stage: 'prompt_execution',
        }
      )
    }

    const completedIterations = iterationCount > 0 ? iterationCount : sawError ? 0 : 1
    store.commit(
      events.llmResponseCompleted({
        conversationId,
        userMessageId: userMessage.id,
        createdAt: new Date(),
        iterations: completedIterations,
        success: !sawError,
      })
    )

    return !sawError
  }

  private async getOrCreatePiSession(
    storeId: string,
    conversationId: string,
    storeState: StoreProcessingState,
    store: LiveStore,
    workerId?: string
  ): Promise<PiConversationSession | null> {
    const existing = storeState.piSessions.get(conversationId)
    if (existing) {
      existing.lastAccessedAt = Date.now()
      return existing
    }

    await this.evictPiSessionsIfNeeded(storeId, storeState, conversationId)

    const safeStoreId = this.sanitizePiSegment(storeId)
    const sessionDir = path.join(
      this.piBaseDir,
      safeStoreId,
      this.sanitizePiSegment(conversationId)
    )

    try {
      await fs.mkdir(sessionDir, { recursive: true })
      const { authStorage, modelRegistry, resourceLoader } =
        await this.getOrCreatePiAgentResources(storeId)

      const existingSessionFile = await this.findLatestSessionFile(sessionDir)
      const sessionManager = existingSessionFile
        ? SessionManager.open(existingSessionFile, sessionDir)
        : SessionManager.create(process.cwd(), sessionDir)

      const { session } = await createAgentSession({
        model: this.piModel ?? undefined,
        authStorage,
        modelRegistry,
        resourceLoader,
        sessionManager,
        tools: [],
        customTools: createPiTools({ store, workerId }),
      })

      const entry = { session, sessionDir, lastAccessedAt: Date.now() }
      storeState.piSessions.set(conversationId, entry)

      logger.info({ storeId, conversationId, sessionDir }, 'Pi session created')

      return entry
    } catch (error) {
      logger.error(
        { error: this.formatErrorForLog(error), storeId, conversationId },
        'Failed to create Pi session'
      )
      this.captureAgentError(error, {
        storeId,
        conversationId,
        stage: 'session_initialization',
      })
      return null
    }
  }

  private async getOrCreatePiAgentResources(storeId: string): Promise<PiAgentResources> {
    const cached = this.piAgentResourcesByStore.get(storeId)
    if (cached) {
      return cached
    }

    const inFlight = this.piAgentResourceInitPromises.get(storeId)
    if (inFlight) {
      return inFlight
    }

    const safeStoreId = this.sanitizePiSegment(storeId)
    const agentDir = path.join(this.piBaseDir, safeStoreId, 'agent')

    const initPromise = (async () => {
      await fs.mkdir(agentDir, { recursive: true })

      const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'))
      const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'))
      this.configurePiProviderOverrides(modelRegistry)
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir,
      })
      await resourceLoader.reload()

      const resources: PiAgentResources = {
        agentDir,
        authStorage,
        modelRegistry,
        resourceLoader,
      }
      this.piAgentResourcesByStore.set(storeId, resources)
      return resources
    })()

    this.piAgentResourceInitPromises.set(storeId, initPromise)

    try {
      return await initPromise
    } finally {
      this.piAgentResourceInitPromises.delete(storeId)
    }
  }

  private clearPiAgentResources(storeId: string): void {
    this.piAgentResourceInitPromises.delete(storeId)
    this.piAgentResourcesByStore.delete(storeId)
  }

  private sanitizePiSegment(value: string): string {
    // Keep path segments filesystem-safe and non-traversable by disallowing dots entirely.
    const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '_')
    return sanitized.length > 0 ? sanitized : '_'
  }

  private configurePiProviderOverrides(modelRegistry: ModelRegistry): void {
    if (this.llmProviderMode !== 'braintrust' || !this.braintrustBaseUrl) {
      return
    }

    const headers: Record<string, string> | undefined = this.braintrustProjectId
      ? { 'x-bt-parent': `project_id:${this.braintrustProjectId}` }
      : undefined

    modelRegistry.registerProvider('braintrust', {
      baseUrl: this.braintrustBaseUrl,
      apiKey: 'BRAINTRUST_API_KEY',
      headers,
    })
  }

  private async findLatestSessionFile(sessionDir: string): Promise<string | null> {
    try {
      const entries = await fs.readdir(sessionDir, { withFileTypes: true })
      const sessionFiles = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(entry => path.join(sessionDir, entry.name))

      if (sessionFiles.length === 0) {
        return null
      }

      const stats = await Promise.all(
        sessionFiles.map(async filePath => ({
          filePath,
          stat: await fs.stat(filePath),
        }))
      )

      stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      return stats[0]?.filePath ?? null
    } catch (error) {
      logger.warn(
        { error: this.formatErrorForLog(error), sessionDir },
        'Failed to inspect existing Pi sessions'
      )
      return null
    }
  }

  private async evictPiSessionsIfNeeded(
    storeId: string,
    storeState: StoreProcessingState,
    preserveConversationId?: string
  ): Promise<void> {
    if (storeState.piSessions.size === 0) {
      return
    }

    const now = Date.now()

    if (this.piSessionIdleTtlMs > 0) {
      for (const [cachedConversationId, entry] of Array.from(storeState.piSessions.entries())) {
        if (
          this.shouldPreservePiSession(storeState, cachedConversationId, preserveConversationId)
        ) {
          continue
        }

        const idleDurationMs = now - entry.lastAccessedAt
        if (idleDurationMs >= this.piSessionIdleTtlMs) {
          await this.disposePiSessionEntry(
            storeState,
            storeId,
            cachedConversationId,
            entry,
            'idle_ttl_exceeded',
            {
              idleDurationMs,
              ttlMs: this.piSessionIdleTtlMs,
            }
          )
        }
      }
    }

    if (
      this.maxPiSessionsPerStore <= 0 ||
      storeState.piSessions.size < this.maxPiSessionsPerStore
    ) {
      return
    }

    const targetSizeBeforeInsert = Math.max(this.maxPiSessionsPerStore - 1, 0)
    const evictionCandidates = Array.from(storeState.piSessions.entries())
      .filter(([cachedConversationId]) => {
        return !this.shouldPreservePiSession(
          storeState,
          cachedConversationId,
          preserveConversationId
        )
      })
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)

    for (const [cachedConversationId, entry] of evictionCandidates) {
      if (storeState.piSessions.size <= targetSizeBeforeInsert) {
        break
      }

      await this.disposePiSessionEntry(
        storeState,
        storeId,
        cachedConversationId,
        entry,
        'capacity_lru'
      )
    }

    if (storeState.piSessions.size > targetSizeBeforeInsert) {
      logger.warn(
        {
          storeId,
          cacheSize: storeState.piSessions.size,
          maxPiSessionsPerStore: this.maxPiSessionsPerStore,
          preserveConversationId,
          activeConversations: storeState.activeConversations.size,
        },
        'Pi session cache exceeded capacity with no evictable idle sessions'
      )
    }
  }

  private shouldPreservePiSession(
    storeState: StoreProcessingState,
    conversationId: string,
    preserveConversationId?: string
  ): boolean {
    return (
      conversationId === preserveConversationId ||
      storeState.activeConversations.has(conversationId)
    )
  }

  private async disposePiSessionEntry(
    storeState: StoreProcessingState,
    storeId: string,
    conversationId: string,
    entry: PiConversationSession,
    reason: 'idle_ttl_exceeded' | 'capacity_lru' | 'store_cleanup',
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await entry.session.dispose()
    } catch (error) {
      logger.warn(
        { error: this.formatErrorForLog(error), storeId, conversationId },
        'Failed to dispose Pi session cleanly'
      )
      this.captureAgentError(error, {
        storeId,
        conversationId,
        stage: 'session_dispose',
      })
    } finally {
      storeState.piSessions.delete(conversationId)
    }

    logger.debug(
      {
        storeId,
        conversationId,
        reason,
        cacheSizeAfterEviction: storeState.piSessions.size,
        ...metadata,
      },
      'Disposed Pi session from cache'
    )
  }

  private captureAgentError(
    error: unknown,
    context: {
      storeId: string
      conversationId?: string
      userMessageId?: string
      correlationId?: string | null
      stage: 'session_initialization' | 'session_dispose' | 'prompt_execution'
    }
  ): void {
    const exception = error instanceof Error ? error : new Error(String(error))

    Sentry.withScope(scope => {
      scope.setTag('agent.integration', 'pi')
      scope.setTag('agent.stage', context.stage)
      scope.setTag('store_id', context.storeId)
      if (context.conversationId) {
        scope.setTag('conversation_id', context.conversationId)
      }
      if (context.userMessageId) {
        scope.setTag('message_id', context.userMessageId)
      }
      if (context.correlationId) {
        scope.setTag('correlation_id', context.correlationId)
      }
      scope.setContext('agent_error_context', context)
      Sentry.captureException(exception)
    })
  }

  private formatErrorForLog(error: unknown, depth = 0): Record<string, unknown> {
    if (depth >= 2) {
      return { type: 'error-depth-limit', value: String(error) }
    }

    if (error instanceof Error) {
      const typedError = error as Error & {
        code?: unknown
        status?: unknown
        statusCode?: unknown
      }

      return {
        type: error.constructor?.name || 'Error',
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: typedError.code,
        status: typedError.status ?? typedError.statusCode,
        cause:
          error.cause !== undefined ? this.formatErrorForLog(error.cause, depth + 1) : undefined,
        details: this.toSafeLogValue(
          Object.fromEntries(
            Object.entries(typedError).filter(
              ([key]) => key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause'
            )
          )
        ),
      }
    }

    return {
      type: error === null ? 'null' : typeof error,
      value: this.toSafeLogValue(error),
    }
  }

  private toSafeLogValue(value: unknown): unknown {
    try {
      return JSON.parse(
        JSON.stringify(value, (_key, nestedValue: unknown) => {
          if (nestedValue instanceof Error) {
            return {
              name: nestedValue.name,
              message: nestedValue.message,
              stack: nestedValue.stack,
            }
          }
          if (typeof nestedValue === 'bigint') {
            return nestedValue.toString()
          }
          return nestedValue
        })
      )
    } catch {
      return String(value)
    }
  }

  private isAssistantErrorMessage(message: Message): message is AssistantMessage {
    if (message.role !== 'assistant') {
      return false
    }

    return (
      message.stopReason === 'error' ||
      message.stopReason === 'aborted' ||
      typeof message.errorMessage === 'string'
    )
  }

  private extractAssistantText(message: Message): string {
    if (message.role !== 'assistant') {
      return ''
    }

    return message.content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
  }

  private extractToolResultText(content?: Array<{ type: string; text?: string }>): string | null {
    if (!content || content.length === 0) {
      return null
    }

    const text = content
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text ?? '')
      .join('')

    return text.trim().length > 0 ? text : null
  }

  /**
   * Process any queued messages for a conversation
   */
  private async processQueuedMessages(
    storeId: string,
    conversationId: string,
    storeState: StoreProcessingState
  ): Promise<void> {
    // Process all queued messages sequentially using async queue processor
    // Safety counter to prevent infinite loops
    let processedCount = 0
    const maxProcessedMessages = 100 // Reasonable limit

    while (
      storeState.messageQueue.hasMessages(conversationId) &&
      processedCount < maxProcessedMessages
    ) {
      processedCount++
      const nextMessage = storeState.messageQueue.dequeue(conversationId)

      if (!nextMessage) {
        break
      }

      logger.debug(
        { conversationId, remaining: storeState.messageQueue.getQueueLength(conversationId) },
        `Processing queued message`
      )

      // Get or create async processor for this conversation
      let processor = storeState.conversationProcessors.get(conversationId)
      if (!processor) {
        processor = new AsyncQueueProcessor()
        storeState.conversationProcessors.set(conversationId, processor)
      }

      try {
        // Queue the message processing task for sequential execution
        await processor.enqueue(`msg-${nextMessage.id}`, async () => {
          await this.processQueuedMessage(storeId, nextMessage, storeState)
        })
      } catch (error) {
        logger.error(
          { error: this.formatErrorForLog(error), conversationId },
          `Error processing queued message`
        )

        // Emit error to conversation
        const store = this.storeManager.getStore(storeId)
        if (store) {
          store.commit(
            events.llmResponseReceived({
              id: crypto.randomUUID(),
              conversationId,
              message: 'Error processing queued message. Please try again.',
              role: 'assistant',
              modelId: 'error',
              responseToMessageId: nextMessage.id,
              createdAt: new Date(),
              llmMetadata: { source: 'queue-processing-error' },
            })
          )
        }
      }
    }

    // Log warning if we hit the safety limit
    if (processedCount >= maxProcessedMessages) {
      logger.warn(
        {
          processedCount,
          conversationId,
          remaining: storeState.messageQueue.getQueueLength(conversationId),
        },
        `Hit safety limit processing messages`
      )
    }

    // Clean up processor if no more messages
    if (!storeState.messageQueue.hasMessages(conversationId)) {
      const processor = storeState.conversationProcessors.get(conversationId)
      if (processor && !processor.isProcessing()) {
        processor.destroy()
        storeState.conversationProcessors.delete(conversationId)
      }
    }
  }

  private incrementErrorCount(storeId: string, error: Error): void {
    const storeState = this.storeStates.get(storeId)
    if (storeState) {
      storeState.errorCount++
      storeState.lastError = error
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushAllBuffers()
    }, this.flushInterval)
  }

  /**
   * Listen for store reconnection events from StoreManager.
   * When a store reconnects, we need to stop monitoring the old (dead) store
   * and start monitoring the new store instance.
   */
  private setupStoreReconnectionHandler(): void {
    this.reconnectionHandler = async ({ storeId, store }) => {
      // Prevent operations after shutdown
      if (this.isShutdown) {
        logger.debug({ storeId }, 'Ignoring storeReconnected event - processor is shutdown')
        return
      }

      logger.info({ storeId }, 'Received storeReconnected event - re-subscribing')

      // Check if we were monitoring this store
      const existingState = this.storeStates.get(storeId)
      if (!existingState) {
        logger.debug({ storeId }, 'Store was not being monitored, skipping re-subscription')
        return
      }

      // Force immediate cleanup of old state (don't wait for async processingQueue.finally)
      // This avoids the race condition where startMonitoring sees stopping=true
      try {
        await this.forceCleanupStoreState(storeId, existingState)
      } catch (error) {
        logger.error(
          { storeId, error: this.formatErrorForLog(error) },
          'Failed to clean up old store state during reconnection'
        )
        return
      }

      // Start fresh monitoring on the new store instance
      this.startMonitoring(storeId, store).catch(error => {
        logger.error({ storeId, error }, 'Failed to re-subscribe after reconnection')
      })
    }

    this.storeManager.on('storeReconnected', this.reconnectionHandler)
  }

  private async disposePiSessions(
    storeId: string,
    storeState: StoreProcessingState
  ): Promise<void> {
    for (const [conversationId, entry] of Array.from(storeState.piSessions.entries())) {
      await this.disposePiSessionEntry(storeState, storeId, conversationId, entry, 'store_cleanup')
    }
  }

  /**
   * Force immediate cleanup of store state for reconnection scenarios.
   * This bypasses the async processingQueue.finally to avoid race conditions.
   */
  private async forceCleanupStoreState(
    storeId: string,
    storeState: StoreProcessingState
  ): Promise<void> {
    // Mark as stopping to signal any in-flight operations to abort
    storeState.stopping = true

    // Unsubscribe from old subscriptions
    for (const unsubscribe of storeState.subscriptions) {
      try {
        unsubscribe()
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Cleanup message queue manager
    storeState.messageQueue.destroy()

    // Cleanup all conversation processors
    for (const processor of storeState.conversationProcessors.values()) {
      processor.destroy()
    }
    storeState.conversationProcessors.clear()

    await this.disposePiSessions(storeId, storeState)
    this.clearPiAgentResources(storeId)

    // Cleanup subscription health tracking
    this.lastSubscriptionUpdate.delete(storeId)
    this.monitoringStartTime.delete(storeId)

    // Remove from state map
    this.storeStates.delete(storeId)

    storeLogger(storeId).debug('Force cleaned up store state for reconnection')
  }

  private async flushAllBuffers(): Promise<void> {
    const flushPromises: Promise<void>[] = []

    for (const [storeId, storeState] of this.storeStates.entries()) {
      const timeSinceFlush = Date.now() - storeState.eventBuffer.lastFlushed.getTime()

      if (
        timeSinceFlush > this.flushInterval &&
        storeState.eventBuffer.events.length > 0 &&
        !storeState.eventBuffer.processing
      ) {
        flushPromises.push(this.scheduleEventProcessing(storeId, storeState))
      }
    }

    await Promise.allSettled(flushPromises)
  }

  stopMonitoring(storeId: string): void {
    const storeState = this.storeStates.get(storeId)
    if (!storeState) {
      storeLogger(storeId).warn(`Store is not being monitored`)
      return
    }

    // Mark as stopping immediately to prevent race conditions
    storeState.stopping = true

    // Unsubscribe from all table subscriptions
    for (const unsubscribe of storeState.subscriptions) {
      try {
        unsubscribe()
      } catch (error) {
        storeLogger(storeId).error({ error }, `Error unsubscribing from store`)
      }
    }

    // Wait for processing to complete before removing state
    void storeState.processingQueue.finally(async () => {
      try {
        // Cleanup message queue manager
        storeState.messageQueue.destroy()

        // Cleanup all conversation processors
        for (const processor of storeState.conversationProcessors.values()) {
          processor.destroy()
        }
        storeState.conversationProcessors.clear()

        await this.disposePiSessions(storeId, storeState)
        this.clearPiAgentResources(storeId)
      } catch (error) {
        storeLogger(storeId).error(
          { error: this.formatErrorForLog(error) },
          'Error during stopMonitoring cleanup'
        )
      } finally {
        // Cleanup subscription health tracking
        this.lastSubscriptionUpdate.delete(storeId)
        this.monitoringStartTime.delete(storeId)

        this.storeStates.delete(storeId)
        storeLogger(storeId).info('Stopped event monitoring')
      }
    })
  }

  stopAll(): void {
    // Set shutdown flag first to prevent reconnection handler from starting new monitoring
    this.isShutdown = true

    // Remove reconnection event listener to prevent use-after-close
    if (this.reconnectionHandler) {
      this.storeManager.removeListener('storeReconnected', this.reconnectionHandler)
      this.reconnectionHandler = null
    }

    const storeIds = Array.from(this.storeStates.keys())

    for (const storeId of storeIds) {
      this.stopMonitoring(storeId)
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }

    this.clearLlmCallTracking()

    // Cleanup processed message tracker
    this.processedTracker.close().catch(error => {
      logger.error(
        { error: this.formatErrorForLog(error) },
        'Error closing processed message tracker'
      )
    })

    // Cleanup global message lifecycle tracker (stops its cleanup timer)
    destroyMessageLifecycleTracker()

    logger.info('Stopped all event monitoring')
  }

  getProcessingStats(): Map<
    string,
    {
      errorCount: number
      lastError?: string
      bufferSize: number
      processing: boolean
      lastFlushed: string
      tablesMonitored: number
      activeConversations: number
      queuedMessages: number
      resourceMetrics: any
      cacheStats: any
    }
  > {
    const stats = new Map()

    for (const [storeId, storeState] of this.storeStates) {
      stats.set(storeId, {
        errorCount: storeState.errorCount,
        lastError: storeState.lastError?.message,
        bufferSize: storeState.eventBuffer.events.length,
        processing: storeState.eventBuffer.processing,
        lastFlushed: storeState.eventBuffer.lastFlushed.toISOString(),
        tablesMonitored: storeState.subscriptions.length,
        activeConversations: storeState.activeConversations.size,
        queuedMessages: storeState.messageQueue.getTotalQueuedMessages(),
        resourceMetrics: null,
        cacheStats: { size: 0, maxSize: 0, entries: [] },
      })
    }

    return stats
  }

  async getLiveStoreStats(): Promise<LiveStoreStatsResult> {
    const perStore = new Map<string, LiveStoreStatsEntry>()
    const totalsAccumulator = {
      chatMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      processedUserMessages: 0,
      pendingUserMessages: 0,
      conversations: 0,
      lastMessageAt: null as number | null,
      lastUserMessageAt: null as number | null,
      lastAssistantMessageAt: null as number | null,
    }

    const stores = this.storeManager.getAllStores()

    for (const [storeId, store] of stores) {
      try {
        // Use the same queryDb pattern as the rest of the codebase
        const rawMessages = store.query(queryDb(tables.chatMessages.select()))
        const rawConversations = store.query(queryDb(tables.conversations.select()))
        const processedUserMessages = await this.processedTracker.getProcessedCount(storeId)

        const chatMessages = Array.isArray(rawMessages) ? rawMessages : []
        const conversations = Array.isArray(rawConversations) ? rawConversations : []

        let userMessages = 0
        let assistantMessages = 0
        let lastMessageTimestamp: number | null = null
        let lastUserMessageTimestamp: number | null = null
        let lastAssistantMessageTimestamp: number | null = null

        for (const message of chatMessages) {
          const timestamp = toTimestamp((message as any)?.createdAt)

          if (timestamp !== null) {
            lastMessageTimestamp =
              lastMessageTimestamp === null ? timestamp : Math.max(lastMessageTimestamp, timestamp)
          }

          const role = (message as any)?.role
          if (role === 'user') {
            userMessages += 1
            if (timestamp !== null) {
              lastUserMessageTimestamp =
                lastUserMessageTimestamp === null
                  ? timestamp
                  : Math.max(lastUserMessageTimestamp, timestamp)
            }
          } else if (role === 'assistant') {
            assistantMessages += 1
            if (timestamp !== null) {
              lastAssistantMessageTimestamp =
                lastAssistantMessageTimestamp === null
                  ? timestamp
                  : Math.max(lastAssistantMessageTimestamp, timestamp)
            }
          }
        }

        const pendingUserMessages = Math.max(userMessages - processedUserMessages, 0)

        const snapshot: LiveStoreStats = {
          chatMessages: chatMessages.length,
          userMessages,
          assistantMessages,
          processedUserMessages,
          pendingUserMessages,
          conversations: conversations.length,
          lastMessageAt: toIsoString(lastMessageTimestamp),
          lastUserMessageAt: toIsoString(lastUserMessageTimestamp),
          lastAssistantMessageAt: toIsoString(lastAssistantMessageTimestamp),
        }

        perStore.set(storeId, snapshot)

        totalsAccumulator.chatMessages += snapshot.chatMessages
        totalsAccumulator.userMessages += snapshot.userMessages
        totalsAccumulator.assistantMessages += snapshot.assistantMessages
        totalsAccumulator.processedUserMessages += snapshot.processedUserMessages
        totalsAccumulator.pendingUserMessages += snapshot.pendingUserMessages
        totalsAccumulator.conversations += snapshot.conversations

        if (lastMessageTimestamp !== null) {
          totalsAccumulator.lastMessageAt =
            totalsAccumulator.lastMessageAt === null
              ? lastMessageTimestamp
              : Math.max(totalsAccumulator.lastMessageAt, lastMessageTimestamp)
        }

        if (lastUserMessageTimestamp !== null) {
          totalsAccumulator.lastUserMessageAt =
            totalsAccumulator.lastUserMessageAt === null
              ? lastUserMessageTimestamp
              : Math.max(totalsAccumulator.lastUserMessageAt, lastUserMessageTimestamp)
        }

        if (lastAssistantMessageTimestamp !== null) {
          totalsAccumulator.lastAssistantMessageAt =
            totalsAccumulator.lastAssistantMessageAt === null
              ? lastAssistantMessageTimestamp
              : Math.max(totalsAccumulator.lastAssistantMessageAt, lastAssistantMessageTimestamp)
        }
      } catch (error: any) {
        perStore.set(storeId, {
          error: error?.message ?? 'Failed to retrieve LiveStore statistics for this store.',
        })
      }
    }

    const totals: LiveStoreStats = {
      chatMessages: totalsAccumulator.chatMessages,
      userMessages: totalsAccumulator.userMessages,
      assistantMessages: totalsAccumulator.assistantMessages,
      processedUserMessages: totalsAccumulator.processedUserMessages,
      pendingUserMessages: totalsAccumulator.pendingUserMessages,
      conversations: totalsAccumulator.conversations,
      lastMessageAt: toIsoString(totalsAccumulator.lastMessageAt),
      lastUserMessageAt: toIsoString(totalsAccumulator.lastUserMessageAt),
      lastAssistantMessageAt: toIsoString(totalsAccumulator.lastAssistantMessageAt),
    }

    return {
      perStore,
      totals,
    }
  }

  /**
   * Get global resource status for health endpoint
   */
  getGlobalResourceStatus(options?: { pendingUserMessages?: number; userMessages?: number }): {
    systemHealth: 'healthy' | 'stressed' | 'critical'
    activeLLMCalls: number
    queuedMessages: number
    activeConversations: number
    errorRate: number | null
    avgResponseTime: number | null
    cacheHitRate: number | null
    alerts: number
    pendingUserMessages: number | null
    userMessages: number | null
    notes?: string
  } {
    const totals = Array.from(this.storeStates.values()).reduce(
      (acc, state) => {
        acc.activeConversations += state.activeConversations.size
        acc.queuedMessages += state.messageQueue.getTotalQueuedMessages()
        return acc
      },
      { activeConversations: 0, queuedMessages: 0 }
    )

    const recentErrorRate = this.getRecentErrorRate()
    const averageResponseTime = this.getAverageResponseTime()

    let systemHealth: 'healthy' | 'stressed' | 'critical' = 'healthy'

    const queueNearCapacity =
      this.maxQueuedMessages > 0 && totals.queuedMessages >= this.maxQueuedMessages * 0.8
    const llmAtCapacity =
      this.maxConcurrentLLMCalls > 0 && this.activeLLMCalls >= this.maxConcurrentLLMCalls

    const backlog = options?.pendingUserMessages ?? null
    if (queueNearCapacity || llmAtCapacity || (recentErrorRate ?? 0) > 10) {
      systemHealth = 'stressed'
    }

    const noteSegments = [
      'In-process resource monitor disabled; rely on Render dashboards for CPU/memory metrics.',
    ]

    if (backlog && backlog > 0) {
      noteSegments.push(`LiveStore backlog: ${backlog} pending user message(s).`)
    }

    return {
      systemHealth,
      activeLLMCalls: this.activeLLMCalls,
      queuedMessages: totals.queuedMessages,
      activeConversations: totals.activeConversations,
      errorRate: recentErrorRate,
      avgResponseTime: averageResponseTime,
      cacheHitRate: null,
      alerts: 0,
      pendingUserMessages: backlog,
      userMessages: options?.userMessages ?? null,
      notes: noteSegments.join(' '),
    }
  }

  /**
   * Get the message lifecycle tracker for debugging endpoints
   */
  getLifecycleTracker(): MessageLifecycleTracker {
    return this.lifecycleTracker
  }

  /**
   * Check if a store's subscription is healthy based on last update time
   * A subscription is considered unhealthy if no updates received within threshold
   */
  isSubscriptionHealthy(storeId: string): boolean {
    const lastUpdate = this.lastSubscriptionUpdate.get(storeId)
    if (!lastUpdate) {
      // No updates ever received - check if store is being monitored
      const storeState = this.storeStates.get(storeId)
      if (!storeState) {
        return false // Not monitored
      }
      // Store is monitored but no updates yet - check how long since monitoring started
      const startTime = this.monitoringStartTime.get(storeId)
      if (!startTime) {
        return true // Just started, give it time
      }
      // If monitoring started more than threshold ago but no updates received,
      // the subscription may be broken from initialization
      const monitoringDuration = Date.now() - startTime.getTime()
      return monitoringDuration < this.subscriptionHealthThresholdMs
    }

    const silenceDuration = Date.now() - lastUpdate.getTime()
    return silenceDuration < this.subscriptionHealthThresholdMs
  }

  /**
   * Get detailed subscription health status for all monitored stores
   */
  getSubscriptionHealthStatus(): Map<
    string,
    {
      lastUpdateAt: string | null
      silenceDurationMs: number
      monitoringStartedAt: string | null
      monitoringDurationMs: number
      isHealthy: boolean
      isMonitored: boolean
      thresholdMs: number
    }
  > {
    const status = new Map<
      string,
      {
        lastUpdateAt: string | null
        silenceDurationMs: number
        monitoringStartedAt: string | null
        monitoringDurationMs: number
        isHealthy: boolean
        isMonitored: boolean
        thresholdMs: number
      }
    >()

    // Include all monitored stores
    for (const storeId of this.storeStates.keys()) {
      const lastUpdate = this.lastSubscriptionUpdate.get(storeId)
      const startTime = this.monitoringStartTime.get(storeId)
      const silenceDuration = lastUpdate ? Date.now() - lastUpdate.getTime() : -1
      const monitoringDuration = startTime ? Date.now() - startTime.getTime() : -1

      status.set(storeId, {
        lastUpdateAt: lastUpdate?.toISOString() ?? null,
        silenceDurationMs: silenceDuration,
        monitoringStartedAt: startTime?.toISOString() ?? null,
        monitoringDurationMs: monitoringDuration,
        isHealthy: this.isSubscriptionHealthy(storeId),
        isMonitored: true,
        thresholdMs: this.subscriptionHealthThresholdMs,
      })
    }

    return status
  }

  /**
   * Get processed message statistics for health monitoring
   */
  async getProcessedMessageStats(): Promise<
    | {
        total: number
        byStore: Record<string, number>
        databasePath: string
      }
    | { error: string }
  > {
    try {
      const total = await this.processedTracker.getProcessedCount()
      const byStore: Record<string, number> = {}

      for (const [storeId] of this.storeStates) {
        const count = await this.processedTracker.getProcessedCount(storeId)
        byStore[storeId] = count
      }

      return {
        total,
        byStore,
        databasePath: this.processedTracker.databasePath,
      }
    } catch (error: any) {
      return { error: error.message }
    }
  }

  private canStartLLMCall(): boolean {
    if (this.maxConcurrentLLMCalls <= 0) {
      return true
    }
    return this.activeLLMCalls < this.maxConcurrentLLMCalls
  }

  private beginLLMCall(): string {
    const callId = crypto.randomUUID()
    this.activeLLMCalls += 1
    this.llmCallsInFlight.add(callId)

    if (this.llmCallTimeoutMs > 0) {
      const timeout = setTimeout(() => {
        if (this.llmCallsInFlight.has(callId)) {
          logger.warn({ callId }, 'LLM call timeout')
          this.endLLMCall(callId, true)
        }
      }, this.llmCallTimeoutMs)

      this.llmCallTimeouts.set(callId, timeout)
    }

    return callId
  }

  private endLLMCall(callId: string, isTimeout: boolean, responseTime?: number): void {
    if (!this.llmCallsInFlight.has(callId)) {
      return
    }

    this.llmCallsInFlight.delete(callId)
    if (this.activeLLMCalls > 0) {
      this.activeLLMCalls -= 1
    }

    const timeout = this.llmCallTimeouts.get(callId)
    if (timeout) {
      clearTimeout(timeout)
      this.llmCallTimeouts.delete(callId)
    }

    if (isTimeout) {
      this.recordError()
    } else if (typeof responseTime === 'number') {
      this.recordResponseTime(responseTime)
    }
  }

  private canAcceptIncomingMessage():
    | { allowed: true }
    | { allowed: false; reason: 'queue-limit' | 'rate-limit' } {
    if (this.maxQueuedMessages > 0) {
      const totalQueued = Array.from(this.storeStates.values()).reduce(
        (acc, state) => acc + state.messageQueue.getTotalQueuedMessages(),
        0
      )

      if (totalQueued >= this.maxQueuedMessages) {
        return { allowed: false, reason: 'queue-limit' }
      }
    }

    const now = Date.now()
    this.trimTimestamps(this.messageTimestamps, now, this.messageRateWindowMs)

    if (this.messageRateLimit > 0 && this.messageTimestamps.length >= this.messageRateLimit) {
      return { allowed: false, reason: 'rate-limit' }
    }

    return { allowed: true }
  }

  private recordIncomingMessage(): void {
    const now = Date.now()
    this.messageTimestamps.push(now)
    this.trimTimestamps(this.messageTimestamps, now, this.messageRateWindowMs)
  }

  private recordError(): void {
    const now = Date.now()
    this.errorTimestamps.push(now)
    this.trimTimestamps(this.errorTimestamps, now, this.messageRateWindowMs)
  }

  private recordResponseTime(durationMs: number): void {
    this.responseTimes.push(durationMs)

    if (this.responseTimes.length > 100) {
      this.responseTimes = this.responseTimes.slice(-50)
    }
  }

  private getRecentErrorRate(): number | null {
    if (this.errorTimestamps.length === 0) {
      return null
    }

    const now = Date.now()
    this.trimTimestamps(this.errorTimestamps, now, this.messageRateWindowMs)

    return this.errorTimestamps.length
  }

  private getAverageResponseTime(): number | null {
    if (this.responseTimes.length === 0) {
      return null
    }

    const total = this.responseTimes.reduce((acc, value) => acc + value, 0)
    return Math.round(total / this.responseTimes.length)
  }

  private trimTimestamps(timestamps: number[], now: number, windowMs: number): void {
    const cutoff = now - windowMs
    let firstValidIndex = 0

    while (firstValidIndex < timestamps.length && timestamps[firstValidIndex] < cutoff) {
      firstValidIndex++
    }

    if (firstValidIndex > 0) {
      timestamps.splice(0, firstValidIndex)
    }
  }

  private clearLlmCallTracking(): void {
    for (const timeout of this.llmCallTimeouts.values()) {
      clearTimeout(timeout)
    }
    this.llmCallTimeouts.clear()
    this.llmCallsInFlight.clear()
    this.activeLLMCalls = 0
  }

  private buildConversationHistory(
    chatHistory: ChatMessage[],
    userMessage: ChatMessage
  ): Message[] {
    let historyToUse = chatHistory

    if (historyToUse.length > 0) {
      const lastMessage = historyToUse[historyToUse.length - 1]

      if (lastMessage.id === userMessage.id && lastMessage.role === 'user') {
        historyToUse = historyToUse.slice(0, -1)
        logger.debug(
          {
            conversationId: userMessage.conversationId,
            userMessageId: userMessage.id,
            removedMessageRole: lastMessage.role,
          },
          'Trimming current user message from conversation history before LLM call'
        )
      }
    }

    const api = this.piModel?.api ?? 'anthropic-messages'
    const provider = this.piModel?.provider ?? 'anthropic'
    const model = this.piModel?.id ?? DEFAULT_MODEL

    const sanitizedHistory: Message[] = historyToUse.flatMap((msg): Message[] => {
      if (msg.role === 'user') {
        return [
          {
            role: 'user',
            content: msg.message || '',
            timestamp: msg.createdAt.getTime(),
          },
        ]
      }

      if (msg.role === 'assistant') {
        return [
          {
            role: 'assistant',
            content: [{ type: 'text', text: msg.message || '' }],
            api,
            provider,
            model,
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
            stopReason: 'stop',
            timestamp: msg.createdAt.getTime(),
          },
        ]
      }

      return []
    })

    const duplicateUserMessages: Array<{ index: number; content: string | null }> = []
    for (let i = 1; i < sanitizedHistory.length; i++) {
      const previous = sanitizedHistory[i - 1]
      const current = sanitizedHistory[i]

      if (previous.role === 'user' && current.role === 'user') {
        const previousContent = typeof previous.content === 'string' ? previous.content : null
        const currentContent = typeof current.content === 'string' ? current.content : null
        if (previousContent && previousContent === currentContent) {
          duplicateUserMessages.push({ index: i, content: currentContent })
        }
      }
    }

    if (duplicateUserMessages.length > 0) {
      logger.warn(
        {
          conversationId: userMessage.conversationId,
          userMessageId: userMessage.id,
          duplicates: duplicateUserMessages.map(({ index, content }) => ({
            index,
            preview: content ? content.slice(0, 100) : null,
          })),
        },
        'Detected duplicate consecutive user messages in conversation history'
      )
    }

    return sanitizedHistory
  }

  /**
   * Enrich navigation context with full entity attributes from database
   */
  private async enrichNavigationContext(
    store: LiveStore,
    clientContext: NavigationContext
  ): Promise<NavigationContext> {
    const enriched: NavigationContext = { ...clientContext }

    // If there's a current entity, enrich with full database attributes
    if (clientContext.currentEntity) {
      const { type, id } = clientContext.currentEntity

      try {
        if (type === 'project') {
          const projects = store.query(queryDb(tables.projects.select().where('id', '=', id)))
          const project = projects[0]

          if (project) {
            enriched.currentEntity = {
              type: 'project',
              id: project.id,
              attributes: {
                name: project.name || '(none)',
                description: project.description || '(none)',
                created: this.formatDate(project.createdAt),
                updated: this.formatDate(project.updatedAt),
              },
            }
          }
        } else if (type === 'document') {
          const documents = store.query(queryDb(tables.documents.select().where('id', '=', id)))
          const document = documents[0]

          if (document) {
            enriched.currentEntity = {
              type: 'document',
              id: document.id,
              attributes: {
                title: document.title || '(none)',
                created: this.formatDate(document.createdAt),
                updated: this.formatDate(document.updatedAt),
              },
            }

            // Add related project(s) if document belongs to any
            const docProjects = store.query(
              queryDb(tables.documentProjects.select().where('documentId', '=', id))
            )

            if (docProjects && docProjects.length > 0) {
              const projectIds = new Set(docProjects.map((dp: any) => dp.projectId))
              const allProjects = store.query(queryDb(tables.projects.select()))
              const projects = allProjects.filter((p: any) => projectIds.has(p.id))

              enriched.relatedEntities = projects.map((p: any) => ({
                type: 'project' as const,
                id: p.id,
                relationship: 'parent project',
                attributes: {
                  name: p.name || '(none)',
                  description: p.description || '(none)',
                },
              }))
            }
          }
        } else if (type === 'contact') {
          const contacts = store.query(queryDb(tables.contacts.select().where('id', '=', id)))
          const contact = contacts[0]

          if (contact) {
            enriched.currentEntity = {
              type: 'contact',
              id: contact.id,
              attributes: {
                name: contact.name || '(none)',
                email: contact.email || '(none)',
                created: this.formatDate(contact.createdAt),
                updated: this.formatDate(contact.updatedAt),
              },
            }

            // Add related project(s) if contact is associated with any
            const contactProjects = store.query(
              queryDb(tables.projectContacts.select().where('contactId', '=', id))
            )

            if (contactProjects && contactProjects.length > 0) {
              const projectIds = new Set(contactProjects.map((cp: any) => cp.projectId))
              const allProjects = store.query(queryDb(tables.projects.select()))
              const projects = allProjects.filter((p: any) => projectIds.has(p.id))

              enriched.relatedEntities = projects.map((p: any) => ({
                type: 'project' as const,
                id: p.id,
                relationship: 'associated project',
                attributes: {
                  name: p.name || '(none)',
                  description: p.description || '(none)',
                },
              }))
            }
          }
        } else if (type === 'category') {
          // Categories are static constants, not database entities
          // The frontend already provides the full category info, so just pass it through
          enriched.currentEntity = clientContext.currentEntity
        }
      } catch (error) {
        logger.error(
          { error, entityType: type, entityId: id },
          'Error enriching navigation context'
        )
      }
    }

    return enriched
  }

  /**
   * Format date to YYYY-MM-DD for navigation context
   */
  private formatDate(date: Date | number | string | null | undefined): string {
    if (!date) return '(none)'

    const d = date instanceof Date ? date : new Date(date)
    if (isNaN(d.getTime())) return '(none)'

    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')

    return `${year}-${month}-${day}`
  }
}
