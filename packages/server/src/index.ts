// Load environment variables FIRST, before anything else (including Sentry)
import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageRoot = resolve(__dirname, '..')
dotenv.config({ path: resolve(packageRoot, '.env') })

const globalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
if (typeof globalWebSocket !== 'function') {
  const { WebSocket } = await import('ws')
  ;(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket
}

// IMPORTANT: Import Sentry instrumentation after env vars are loaded
// Using dynamic import to ensure it happens after dotenv.config()
await import('./instrument.js')
import * as Sentry from '@sentry/node'

// IMPORTANT: ALL app modules must be dynamically imported AFTER Sentry.init()
// This ensures pinoIntegration() can instrument the pino logger.
// Static imports are hoisted and resolved before any code runs, so
// any module that transitively imports logger.js would defeat the purpose.
const { applyRenderPreviewOverrides } = await import('./config/preview-runtime.js')
const previewOverrides = applyRenderPreviewOverrides(process.env)
const { logger } = await import('./utils/logger.js')
const { serializeStoreConnectionFields, storeManager } = await import('./services/store-manager.js')
const { EventProcessor } = await import('./services/event-processor.js')
const { WorkspaceOrchestrator } = await import('./services/workspace-orchestrator.js')
const { AuthWorkerWorkspaceDirectory } = await import('./services/workspace-directory.js')
import type { WorkspaceDirectory } from './services/workspace-directory.js'
const { loadStoresConfig } = await import('./config/stores.js')
const { handleWorkspaceWebhook } = await import('./api/workspace-webhooks.js')
const { WorkspaceReconciler, getDisabledReconcilerStatus } =
  await import('./services/workspace-reconciler.js')
// Type imports must remain static - they're erased at runtime and don't affect module loading
import type { WorkspaceReconciler as WorkspaceReconcilerType } from './services/workspace-reconciler.js'
import type { WorkspaceReconcilerStatus } from './services/workspace-reconciler.js'
const { createManualReconcileHandler, createManualReconcileState } =
  await import('./api/manual-reconcile.js')
import type { ManualReconcileState } from './api/manual-reconcile.js'
const { getIncidentDashboardUrl } = await import('./utils/orchestration-telemetry.js')
const { getMessageLifecycleTracker } = await import('./services/message-lifecycle-tracker.js')

if (previewOverrides.applied) {
  logger.info(
    {
      pullRequestNumber: previewOverrides.pullRequestNumber,
      authWorkerInternalUrl: previewOverrides.authWorkerInternalUrl,
      liveStoreSyncUrl: previewOverrides.liveStoreSyncUrl,
      serverBypassTokenOverridden: previewOverrides.serverBypassTokenOverridden ?? false,
      storeIds: process.env.STORE_IDS,
    },
    'Applied Render preview runtime overrides for auth/sync endpoints'
  )
} else if (previewOverrides.isPreview) {
  logger.warn(
    {
      pullRequestNumber: previewOverrides.pullRequestNumber,
      reason: previewOverrides.reason,
    },
    'Render preview environment detected but endpoint overrides were not applied'
  )
}

/**
 * Check if dashboard access is authorized.
 * In development: always allowed
 * In production: requires ?token=<SERVER_BYPASS_TOKEN> query param
 */
function isDashboardAuthorized(req: { url?: string }): boolean {
  const isDev = process.env.NODE_ENV !== 'production'
  if (isDev) return true

  const serverBypassToken = process.env.SERVER_BYPASS_TOKEN
  if (!serverBypassToken) return false

  const url = new URL(req.url || '/', 'http://localhost')
  const providedToken = url.searchParams.get('token')
  return providedToken === serverBypassToken
}

async function main() {
  logger.info('Starting LifeBuild Multi-Store Server...')

  const config = loadStoresConfig()

  await storeManager.initialize(config.storeIds)

  if (config.storeIds.length === 0) {
    logger.warn('No stores configured. Server running in monitoring mode only.')
  }

  // Set up event processor
  const eventProcessor = new EventProcessor(storeManager)
  const workspaceOrchestrator = new WorkspaceOrchestrator(storeManager, eventProcessor)
  const webhookSecret = process.env.WEBHOOK_SECRET

  if (!webhookSecret) {
    logger.warn('WEBHOOK_SECRET not configured. Workspace webhooks will be rejected.')
  }

  // Start monitoring all configured stores (legacy bootstrap support)
  // Try to monitor all stores, even those that failed initial initialization
  // (ensureMonitored will attempt to re-add failed stores via resolveStore)
  const monitoredStoreIds: string[] = []
  const failedStoreIds: string[] = []

  for (const storeId of config.storeIds) {
    try {
      await workspaceOrchestrator.ensureMonitored(storeId)
      monitoredStoreIds.push(storeId)
    } catch (error) {
      failedStoreIds.push(storeId)
      logger.error({ storeId, error }, 'Failed to start monitoring store, continuing with others')
      Sentry.captureException(error, {
        tags: { storeId },
        extra: { phase: 'ensureMonitored', degradedMode: true },
      })
    }
  }

  if (failedStoreIds.length > 0) {
    logger.warn({ failedStoreIds }, 'Some stores failed to monitor and will not be available')
  }

  logger.info(
    { monitoredCount: monitoredStoreIds.length, failedCount: failedStoreIds.length },
    'Event monitoring started'
  )

  const authWorkerUrl =
    process.env.AUTH_WORKER_INTERNAL_URL || process.env.AUTH_WORKER_URL || undefined
  const serverBypassToken = process.env.SERVER_BYPASS_TOKEN
  const reconcileIntervalRaw = Number(process.env.WORKSPACE_RECONCILE_INTERVAL_MS)
  const reconcileInterval = Number.isFinite(reconcileIntervalRaw) ? reconcileIntervalRaw : undefined

  let workspaceReconciler: WorkspaceReconcilerType | null = null
  let disabledReconcilerStatus: WorkspaceReconcilerStatus | null = null
  const manualReconcileIntervalRaw = Number(process.env.MANUAL_RECONCILE_MIN_INTERVAL_MS)
  const manualReconcileMinIntervalMs = Number.isFinite(manualReconcileIntervalRaw)
    ? manualReconcileIntervalRaw
    : 60_000
  const manualReconcileState: ManualReconcileState = createManualReconcileState()

  if (authWorkerUrl && serverBypassToken) {
    const directory: WorkspaceDirectory = new AuthWorkerWorkspaceDirectory({
      baseUrl: authWorkerUrl,
      serverBypassToken,
    })
    workspaceReconciler = new WorkspaceReconciler({
      orchestrator: workspaceOrchestrator,
      directory,
      intervalMs: reconcileInterval,
    })
    workspaceReconciler.start()
  } else {
    const reason = !authWorkerUrl
      ? 'AUTH_WORKER_INTERNAL_URL not configured'
      : 'SERVER_BYPASS_TOKEN not configured'
    disabledReconcilerStatus = getDisabledReconcilerStatus(reason)
  }

  const manualReconcileHandler =
    workspaceReconciler && serverBypassToken
      ? createManualReconcileHandler({
          workspaceReconciler,
          serverBypassToken,
          minIntervalMs: manualReconcileMinIntervalMs,
          state: manualReconcileState,
        })
      : null

  const http = await import('http')
  const healthServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Webhook-Secret, Authorization, X-Server-Token'
    )

    if (req.method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    const pathname = req.url?.split('?')[0] ?? ''

    if (pathname === '/webhooks/workspaces') {
      await handleWorkspaceWebhook(req, res, {
        orchestrator: workspaceOrchestrator,
        secret: webhookSecret,
      })
      return
    }

    if (pathname === '/admin/reconcile') {
      if (!manualReconcileHandler) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Workspace reconciler is not available' }))
      } else {
        await manualReconcileHandler(req, res)
      }
      return
    }

    if (pathname === '/health') {
      const healthStatus = storeManager.getHealthStatus()
      const processingStats = eventProcessor.getProcessingStats()
      const liveStoreStats = await eventProcessor.getLiveStoreStats()
      const globalResourceStatus = eventProcessor.getGlobalResourceStatus({
        pendingUserMessages: liveStoreStats.totals.pendingUserMessages,
        userMessages: liveStoreStats.totals.userMessages,
      })
      const processedStats = await eventProcessor.getProcessedMessageStats()
      const orchestratorSummary = workspaceOrchestrator.getSummary()
      const reconciliationStatus: WorkspaceReconcilerStatus = workspaceReconciler
        ? workspaceReconciler.getStatus()
        : (disabledReconcilerStatus ??
          getDisabledReconcilerStatus('Workspace reconciler not configured'))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: healthStatus.healthy ? 'healthy' : 'degraded',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          storage: 'filesystem',
          dataPath: process.env.STORE_DATA_PATH || './data',
          stores: healthStatus.stores.map(store => ({
            ...store,
            processing: processingStats.get(store.storeId) || null,
            liveStore: liveStoreStats.perStore.get(store.storeId) || null,
          })),
          storeCount: healthStatus.stores.length,
          globalResources: globalResourceStatus,
          liveStoreTotals: liveStoreStats.totals,
          liveStorePerStore: Object.fromEntries(liveStoreStats.perStore),
          processedMessages: processedStats,
          orchestrator: orchestratorSummary,
          reconciliation: reconciliationStatus,
          manualReconcile: {
            lastTriggeredAt: manualReconcileState.lastTriggeredAt
              ? new Date(manualReconcileState.lastTriggeredAt).toISOString()
              : null,
            minIntervalMs: manualReconcileMinIntervalMs,
            inFlight: manualReconcileState.inFlight,
            incidentDashboardUrl: getIncidentDashboardUrl(),
          },
        })
      )
    } else if (pathname === '/debug/subscription-health') {
      // Debug endpoint for subscription health monitoring
      // Requires authorization in production
      if (!isDashboardAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized - add ?token=YOUR_SERVER_BYPASS_TOKEN' }))
        return
      }

      const subscriptionHealth = eventProcessor.getSubscriptionHealthStatus()
      // Use getConnectionStatus for read-only status instead of probeAllConnections which has side effects
      const storeHealth = storeManager.getHealthStatus()
      const networkHealth = storeManager.getNetworkHealthStatus()

      // Combine subscription and connection health
      const combinedHealth: Record<
        string,
        {
          subscription: {
            lastUpdateAt: string | null
            silenceDurationMs: number
            monitoringStartedAt: string | null
            monitoringDurationMs: number
            isHealthy: boolean
            thresholdMs: number
          }
          connection: {
            status: string
            errorCount: number
            networkStatus: {
              isConnected: boolean
              lastUpdatedAt: string
              disconnectedSince?: string
              disconnectedMs?: number
            } | null
            lastNetworkStatusAt: string | null
            lastConnectedAt: string | null
            lastDisconnectedAt: string | null
            offlineDurationMs: number | null
          }
          overallHealthy: boolean
        }
      > = {}

      for (const [storeId, subHealth] of subscriptionHealth) {
        // Find matching store status from health check (read-only)
        const storeStatus = storeHealth.stores.find(s => s.storeId === storeId)
        const storeNetwork = networkHealth.get(storeId)
        combinedHealth[storeId] = {
          subscription: {
            lastUpdateAt: subHealth.lastUpdateAt,
            silenceDurationMs: subHealth.silenceDurationMs,
            monitoringStartedAt: subHealth.monitoringStartedAt,
            monitoringDurationMs: subHealth.monitoringDurationMs,
            isHealthy: subHealth.isHealthy,
            thresholdMs: subHealth.thresholdMs,
          },
          connection: {
            status: storeStatus?.status ?? 'unknown',
            errorCount: storeStatus?.errorCount ?? 0,
            networkStatus: storeNetwork?.networkStatus
              ? {
                  isConnected: storeNetwork.networkStatus.isConnected,
                  lastUpdatedAt: storeNetwork.networkStatus.lastUpdatedAt.toISOString(),
                  disconnectedSince: storeNetwork.networkStatus.disconnectedSince?.toISOString(),
                  disconnectedMs: storeNetwork.networkStatus.disconnectedSince
                    ? Date.now() - storeNetwork.networkStatus.disconnectedSince.getTime()
                    : undefined,
                }
              : null,
            lastNetworkStatusAt: storeNetwork?.lastNetworkStatusAt ?? null,
            lastConnectedAt: storeNetwork?.lastConnectedAt ?? null,
            lastDisconnectedAt: storeNetwork?.lastDisconnectedAt ?? null,
            offlineDurationMs: storeNetwork?.offlineDurationMs ?? null,
          },
          overallHealthy: subHealth.isHealthy && storeStatus?.status === 'connected',
        }
      }

      // Calculate overall system health
      const allHealthy = Object.values(combinedHealth).every(h => h.overallHealthy)
      const anyUnhealthy = Object.values(combinedHealth).some(h => !h.overallHealthy)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          systemHealthy: allHealthy,
          hasUnhealthyStores: anyUnhealthy,
          storeCount: Object.keys(combinedHealth).length,
          stores: combinedHealth,
          storeStatuses: storeHealth.stores,
        })
      )
    } else if (pathname === '/debug/network-health') {
      if (!isDashboardAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized - add ?token=YOUR_SERVER_BYPASS_TOKEN' }))
        return
      }

      const networkHealth = storeManager.getNetworkHealthStatus()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          stores: Object.fromEntries(networkHealth),
        })
      )
    } else if (pathname === '/stores') {
      const storeInfo = storeManager.getAllStoreInfo()
      const processingStats = eventProcessor.getProcessingStats()
      const orchestratorSummary = workspaceOrchestrator.getSummary()
      const reconciliationStatus: WorkspaceReconcilerStatus = workspaceReconciler
        ? workspaceReconciler.getStatus()
        : (disabledReconcilerStatus ??
          getDisabledReconcilerStatus('Workspace reconciler not configured'))
      const stores = Array.from(storeInfo.entries()).map(([id, info]) => ({
        id,
        status: info.status,
        connectedAt: info.connectedAt.toISOString(),
        ...serializeStoreConnectionFields(info),
        lastActivity: info.lastActivity.toISOString(),
        errorCount: info.errorCount,
        reconnectAttempts: info.reconnectAttempts,
        networkStatus: info.networkStatus ?? null,
        lastNetworkStatusAt: info.lastNetworkStatusAt?.toISOString() ?? null,
        offlineDurationMs:
          info.networkStatus?.isConnected === false && info.networkStatus.disconnectedSince
            ? Date.now() - info.networkStatus.disconnectedSince.getTime()
            : null,
        processing: processingStats.get(id) || null,
        orchestrator: orchestratorSummary.stores.find(store => store.storeId === id) || null,
      }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          stores,
          orchestrator: {
            monitoredStoreIds: orchestratorSummary.monitoredStoreIds,
            lastProvisionedAt: orchestratorSummary.lastProvisionedAt,
            lastDeprovisionedAt: orchestratorSummary.lastDeprovisionedAt,
            totalProvisioned: orchestratorSummary.totalProvisioned,
            totalDeprovisioned: orchestratorSummary.totalDeprovisioned,
          },
          reconciliation: reconciliationStatus,
          manualReconcile: {
            lastTriggeredAt: manualReconcileState.lastTriggeredAt
              ? new Date(manualReconcileState.lastTriggeredAt).toISOString()
              : null,
            minIntervalMs: manualReconcileMinIntervalMs,
            inFlight: manualReconcileState.inFlight,
            incidentDashboardUrl: getIncidentDashboardUrl(),
          },
        })
      )
    } else if (pathname === '/') {
      // Check dashboard authorization
      if (!isDashboardAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'text/html' })
        res.end(`
          <html>
            <head><title>Unauthorized</title></head>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>Dashboard Access Denied</h1>
              <p>Add <code>?token=YOUR_SERVER_BYPASS_TOKEN</code> to the URL to access the dashboard.</p>
            </body>
          </html>
        `)
        return
      }

      const healthStatus = storeManager.getHealthStatus()
      const lifecycleTracker = getMessageLifecycleTracker()
      const lifecycleStats = lifecycleTracker.getStats()
      const recentLifecycles = lifecycleTracker.getAllLifecycles().slice(0, 20)
      const inProgressLifecycles = lifecycleTracker.getInProgressLifecycles()
      const errorLifecycles = lifecycleTracker.getLifecyclesByStage('error').slice(0, 10)

      // Preserve token in links for production
      const tokenParam =
        process.env.NODE_ENV === 'production'
          ? `?token=${new URL(req.url || '/', 'http://localhost').searchParams.get('token') || ''}`
          : ''

      // Helper to format elapsed time
      const formatElapsed = (ms: number) => {
        if (ms < 1000) return `${ms}ms`
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
        return `${(ms / 60000).toFixed(1)}m`
      }

      const formatDuration = (ms: number) => {
        if (ms < 1000) return `${ms}ms`
        const totalSeconds = Math.floor(ms / 1000)
        const seconds = totalSeconds % 60
        const totalMinutes = Math.floor(totalSeconds / 60)
        const minutes = totalMinutes % 60
        const hours = Math.floor(totalMinutes / 60)
        const parts: string[] = []
        if (hours > 0) parts.push(`${hours}h`)
        if (minutes > 0 || hours > 0) parts.push(`${minutes}m`)
        parts.push(`${seconds}s`)
        return parts.join(' ')
      }

      // Helper to get stage badge color
      const getStageBadgeClass = (stage: string) => {
        switch (stage) {
          case 'completed':
            return 'badge-success'
          case 'error':
            return 'badge-error'
          case 'processing_started':
          case 'iteration':
            return 'badge-warning'
          default:
            return 'badge-info'
        }
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <html>
          <head>
            <title>LifeBuild Multi-Store Server</title>
            <meta http-equiv="refresh" content="10">
            <style>
              body { font-family: system-ui; padding: 20px; max-width: 1400px; margin: 0 auto; }
              .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
              .panel { border: 1px solid #ddd; border-radius: 8px; padding: 15px; }
              .panel h3 { margin-top: 0; border-bottom: 1px solid #eee; padding-bottom: 10px; }
              .store { margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
              .healthy { background: #e8f5e9; }
              .degraded { background: #fff3e0; }
              .error { background: #ffebee; }
              .status-connected { color: green; }
              .status-connecting { color: orange; }
              .status-disconnected { color: red; }
              .status-error { color: darkred; }
              .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
              .badge-success { background: #d4edda; color: #155724; }
              .badge-error { background: #f8d7da; color: #721c24; }
              .badge-warning { background: #fff3cd; color: #856404; }
              .badge-info { background: #d1ecf1; color: #0c5460; }
              .stat-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #f0f0f0; }
              .stat-label { color: #666; }
              .stat-value { font-weight: 600; }
              .message-item { padding: 10px; margin: 8px 0; background: #f8f9fa; border-radius: 6px; font-size: 13px; }
              .message-item.in-progress { background: #fff3cd; border-left: 3px solid #ffc107; }
              .message-item.error { background: #f8d7da; border-left: 3px solid #dc3545; }
              .message-id { font-family: monospace; font-size: 11px; color: #666; }
              .tool-list { font-size: 11px; color: #666; margin-top: 4px; }
              .error-message { color: #721c24; font-size: 12px; margin-top: 4px; word-break: break-word; }
              .timestamp { font-size: 11px; color: #999; }
              .refresh-note { font-size: 12px; color: #666; font-style: italic; }
              details { margin: 5px 0; }
              summary { cursor: pointer; }
              pre { background: #f5f5f5; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 11px; }
            </style>
          </head>
          <body>
            <h1>LifeBuild Multi-Store Server</h1>
            <p class="refresh-note">Auto-refreshes every 10 seconds</p>

            <div class="grid">
              <!-- System Overview Panel -->
              <div class="panel">
                <h3>System Overview</h3>
                <div class="stat-row">
                  <span class="stat-label">Status</span>
                  <span class="stat-value">${healthStatus.healthy ? '✅ Healthy' : '⚠️ Degraded'}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">Storage</span>
                  <span class="stat-value">${process.env.STORE_DATA_PATH || './data'}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">Active Stores</span>
                  <span class="stat-value">${healthStatus.stores.length}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">Uptime</span>
                  <span class="stat-value">${formatElapsed(process.uptime() * 1000)}</span>
                </div>
                <p style="margin-top: 15px;">
                  <a href="/health${tokenParam}">Health JSON</a> |
                  <a href="/stores${tokenParam}">Stores JSON</a> |
                  <a href="/debug/network-health${tokenParam}">Network JSON</a>
                </p>
              </div>

              <!-- Message Lifecycle Stats Panel -->
              <div class="panel">
                <h3>Message Lifecycle Stats</h3>
                <div class="stat-row">
                  <span class="stat-label">Total Tracked</span>
                  <span class="stat-value">${lifecycleStats.total}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">Completed</span>
                  <span class="stat-value badge badge-success">${lifecycleStats.byStage.completed}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">In Progress</span>
                  <span class="stat-value badge badge-warning">${inProgressLifecycles.length}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">Errors</span>
                  <span class="stat-value badge badge-error">${lifecycleStats.byStage.error}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">Avg Processing Time</span>
                  <span class="stat-value">${lifecycleStats.avgProcessingTimeMs ? formatElapsed(lifecycleStats.avgProcessingTimeMs) : 'N/A'}</span>
                </div>
              </div>
            </div>

            <!-- Store Status -->
            <div class="panel" style="margin-top: 20px;">
              <h3>Store Status</h3>
              <div id="stores">
                ${
                  healthStatus.stores.length === 0
                    ? '<p>No stores configured</p>'
                    : healthStatus.stores
                        .map(
                          store => `
                          <div class="store ${store.status === 'connected' ? 'healthy' : store.status === 'connecting' ? 'degraded' : 'error'}">
                            <strong>${store.storeId}</strong>
                            <span class="status-${store.status}">● ${store.status}</span>
                            <br>
                            <small>
                              Connected: ${new Date(store.connectedAt).toLocaleString()}<br>
                              Last Activity: ${new Date(store.lastActivity).toLocaleString()}<br>
                              Network: ${
                                store.networkStatus?.isConnected === false
                                  ? '<span class="status-disconnected">offline</span>'
                                  : store.networkStatus?.isConnected === true
                                    ? '<span class="status-connected">online</span>'
                                    : '<span class="status-connecting">unknown</span>'
                              } ${
                                store.networkStatus?.isConnected === false &&
                                store.networkStatus?.disconnectedSince
                                  ? `for ${formatDuration(Date.now() - new Date(store.networkStatus.disconnectedSince).getTime())}`
                                  : ''
                              }<br>
                              Errors: ${store.errorCount} | Reconnect Attempts: ${store.reconnectAttempts}
                            </small>
                          </div>
                        `
                        )
                        .join('')
                }
              </div>
            </div>

            <div class="grid" style="margin-top: 20px;">
              <!-- In-Progress Messages Panel -->
              <div class="panel">
                <h3>In-Progress Messages (${inProgressLifecycles.length})</h3>
                ${
                  inProgressLifecycles.length === 0
                    ? '<p style="color: #666;">No messages currently processing</p>'
                    : inProgressLifecycles
                        .map(
                          lc => `
                          <div class="message-item in-progress">
                            <div>
                              <span class="badge ${getStageBadgeClass(lc.currentStage)}">${lc.currentStage}</span>
                              <span class="timestamp">${formatElapsed(Date.now() - lc.createdAt.getTime())} ago</span>
                            </div>
                            <div class="message-id">ID: ${lc.messageId}</div>
                            <div class="message-id">Store: ${lc.storeId}</div>
                            ${lc.stages.iterations.length > 0 ? `<div class="tool-list">Iterations: ${lc.stages.iterations.length}</div>` : ''}
                            ${
                              lc.stages.iterations.length > 0 &&
                              lc.stages.iterations[lc.stages.iterations.length - 1].toolNames
                                ? `<div class="tool-list">Last tools: ${lc.stages.iterations[lc.stages.iterations.length - 1].toolNames?.join(', ')}</div>`
                                : ''
                            }
                          </div>
                        `
                        )
                        .join('')
                }
              </div>

              <!-- Recent Errors Panel -->
              <div class="panel">
                <h3>Recent Errors (${errorLifecycles.length})</h3>
                ${
                  errorLifecycles.length === 0
                    ? '<p style="color: #666;">No recent errors</p>'
                    : errorLifecycles
                        .map(
                          lc => `
                          <div class="message-item error">
                            <div>
                              <span class="badge badge-error">${lc.stages.error?.code || 'ERROR'}</span>
                              <span class="timestamp">${lc.stages.error?.timestamp ? new Date(lc.stages.error.timestamp).toLocaleString() : ''}</span>
                            </div>
                            <div class="message-id">ID: ${lc.messageId}</div>
                            <div class="message-id">Store: ${lc.storeId}</div>
                            <div class="error-message">${lc.stages.error?.message || 'Unknown error'}</div>
                            ${
                              lc.stages.error?.stack
                                ? `<details><summary>Stack trace</summary><pre>${lc.stages.error.stack}</pre></details>`
                                : ''
                            }
                          </div>
                        `
                        )
                        .join('')
                }
              </div>
            </div>

            <!-- Recent Messages Panel -->
            <div class="panel" style="margin-top: 20px;">
              <h3>Recent Messages (Last 20)</h3>
              ${
                recentLifecycles.length === 0
                  ? '<p style="color: #666;">No messages tracked yet</p>'
                  : `
                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                      <thead>
                        <tr style="text-align: left; border-bottom: 2px solid #ddd;">
                          <th style="padding: 8px;">Message ID</th>
                          <th style="padding: 8px;">Store</th>
                          <th style="padding: 8px;">Stage</th>
                          <th style="padding: 8px;">Iterations</th>
                          <th style="padding: 8px;">Duration</th>
                          <th style="padding: 8px;">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${recentLifecycles
                          .map(
                            lc => `
                            <tr style="border-bottom: 1px solid #eee;">
                              <td style="padding: 8px; font-family: monospace; font-size: 11px;">${lc.messageId.substring(0, 12)}...</td>
                              <td style="padding: 8px; font-family: monospace; font-size: 11px;">${lc.storeId.substring(0, 12)}...</td>
                              <td style="padding: 8px;"><span class="badge ${getStageBadgeClass(lc.currentStage)}">${lc.currentStage}</span></td>
                              <td style="padding: 8px;">${lc.stages.iterations.length}</td>
                              <td style="padding: 8px;">${lc.stages.completed ? formatElapsed(lc.stages.completed.timestamp.getTime() - lc.createdAt.getTime()) : formatElapsed(Date.now() - lc.createdAt.getTime()) + ' (ongoing)'}</td>
                              <td style="padding: 8px; font-size: 11px;">${new Date(lc.createdAt).toLocaleTimeString()}</td>
                            </tr>
                          `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  `
              }
            </div>
          </body>
        </html>
      `)
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not Found')
    }
  })

  const PORT = process.env.PORT || 3003
  healthServer.listen(PORT, () => {
    logger.info({ port: PORT }, `Server listening on port ${PORT}`)
    logger.info(`Health endpoint: http://localhost:${PORT}/health`)
    logger.info(`Store status: http://localhost:${PORT}/stores`)
    logger.info(`Dashboard: http://localhost:${PORT}/`)
  })

  const shutdown = async () => {
    logger.info('Shutting down server...')
    healthServer.close()
    workspaceReconciler?.stop()
    await workspaceOrchestrator.shutdown()

    // Flush any pending Sentry events before exiting
    logger.info('Flushing Sentry events...')
    await Sentry.flush(2000)

    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(error => {
  logger.error({ error }, 'Failed to start server')
  // Capture the error in Sentry before exiting
  Sentry.captureException(error)
  // Ensure the error is sent to Sentry before process exits
  Sentry.flush(2000).finally(() => {
    process.exit(1)
  })
})
