import React, { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ROUTES } from '../../constants/routes.js'
import { useQuery } from '../../livestore-compat.js'
import { useAuth } from '../../contexts/AuthContext.js'
import { usePostHog } from '../../lib/analytics.js'
import { getUsers$ } from '@lifebuild/shared/queries'
import type { User } from '@lifebuild/shared/schema'
import { getInitials, isCurrentUserAdmin } from '../utils/helpers.js'
import { AttendantChatPanel } from './AttendantChatPanel.js'
import { AttendantRail } from './AttendantRail.js'
import { useAttendantRail } from './AttendantRailProvider.js'
import { LiveStoreStatus } from './LiveStoreStatus.js'
import { TaskQueuePanel } from '../task-queue/TaskQueuePanel.js'
import { useOnboarding } from '../onboarding/useOnboarding.js'
import { MapSpriteDebugProvider } from './MapSpriteDebugContext.js'
import {
  DEFAULT_MAP_SPRITE_DEBUG_SETTINGS,
  MAP_TREE_SPRITE_CONFIGS,
  type MapTreeSpriteId,
  type MapSpriteOrigin,
  type MapSpriteDebugSettings,
} from '../life-map/mapSpriteDebugConfig.js'

type NewUiShellProps = {
  children: React.ReactNode
  /** When true, uses h-screen flex layout for full-height content like project views */
  fullHeight?: boolean
  /** When true, disables scrolling on main content (children handle their own scrolling, e.g. project views) */
  noScroll?: boolean
  /** When true, removes content padding/max-width so children can render edge-to-edge */
  fullBleed?: boolean
}

const MAP_SPRITE_DEBUG_STORAGE_KEY = 'lifebuild:map-sprite-debug-v1'
const MIN_SPRITE_SCALE = 0.35
const MAX_SPRITE_SCALE = 2.8
const MIN_SPRITE_ORIGIN = -1.5
const MAX_SPRITE_ORIGIN = 1.5

const clampSpriteScale = (value: number): number => {
  return Math.min(MAX_SPRITE_SCALE, Math.max(MIN_SPRITE_SCALE, value))
}

const clampSpriteOrigin = (value: number): number => {
  return Math.min(MAX_SPRITE_ORIGIN, Math.max(MIN_SPRITE_ORIGIN, value))
}

const parseSpriteOrigin = (value: unknown, fallback: MapSpriteOrigin): MapSpriteOrigin => {
  if (!value || typeof value !== 'object') {
    return fallback
  }

  const parsed = value as Partial<MapSpriteOrigin>

  return {
    x: clampSpriteOrigin(typeof parsed.x === 'number' ? parsed.x : fallback.x),
    y: clampSpriteOrigin(typeof parsed.y === 'number' ? parsed.y : fallback.y),
  }
}

const parseMapSpriteDebugSettings = (raw: string | null): MapSpriteDebugSettings | null => {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MapSpriteDebugSettings>
    const parsedTreeScales = parsed.treeScales ?? {}
    const parsedTreeOrigins = parsed.treeOrigins ?? {}

    return {
      sanctuaryScale: clampSpriteScale(
        typeof parsed.sanctuaryScale === 'number'
          ? parsed.sanctuaryScale
          : DEFAULT_MAP_SPRITE_DEBUG_SETTINGS.sanctuaryScale
      ),
      workshopScale: clampSpriteScale(
        typeof parsed.workshopScale === 'number'
          ? parsed.workshopScale
          : DEFAULT_MAP_SPRITE_DEBUG_SETTINGS.workshopScale
      ),
      sanctuaryOrigin: parseSpriteOrigin(
        parsed.sanctuaryOrigin,
        DEFAULT_MAP_SPRITE_DEBUG_SETTINGS.sanctuaryOrigin
      ),
      workshopOrigin: parseSpriteOrigin(
        parsed.workshopOrigin,
        DEFAULT_MAP_SPRITE_DEBUG_SETTINGS.workshopOrigin
      ),
      treeScales: Object.fromEntries(
        MAP_TREE_SPRITE_CONFIGS.map(tree => {
          const parsedScale = parsedTreeScales[tree.id]
          const resolvedScale =
            typeof parsedScale === 'number'
              ? parsedScale
              : DEFAULT_MAP_SPRITE_DEBUG_SETTINGS.treeScales[tree.id]

          return [tree.id, clampSpriteScale(resolvedScale ?? tree.defaultScale)]
        })
      ) as MapSpriteDebugSettings['treeScales'],
      treeOrigins: Object.fromEntries(
        MAP_TREE_SPRITE_CONFIGS.map(tree => {
          const parsedOrigin = parsedTreeOrigins[tree.id]
          return [
            tree.id,
            parseSpriteOrigin(
              parsedOrigin,
              DEFAULT_MAP_SPRITE_DEBUG_SETTINGS.treeOrigins[tree.id] ?? tree.defaultOrigin
            ),
          ]
        })
      ) as MapSpriteDebugSettings['treeOrigins'],
    }
  } catch {
    return null
  }
}

/**
 * Minimal shell for the next-generation UI surfaces.
 * Keeps global chrome while providing configurable content geometry.
 */
export const NewUiShell: React.FC<NewUiShellProps> = ({
  children,
  fullHeight = false,
  noScroll = false,
  fullBleed = false,
}) => {
  const { activeAttendantId, closeAttendant, toggleAttendant } = useAttendantRail()
  const onboarding = useOnboarding()
  const { user: authUser, isAuthenticated, logout } = useAuth()
  const users = useQuery(getUsers$) ?? []
  const posthog = usePostHog()
  const isMapSpriteDebugEnvironment =
    import.meta.env.DEV || import.meta.env.VITE_E2E_TEST_HOOKS === 'true'
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, right: 0 })
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [isDebugPanelOpen, setIsDebugPanelOpen] = useState(false)
  const debugPanelRef = useRef<HTMLDivElement>(null)
  const debugButtonRef = useRef<HTMLButtonElement>(null)
  const [isRailVisible, setIsRailVisible] = useState(!onboarding.uiPolicy.railFadingIn)
  const [mapSpriteDebugSettings, setMapSpriteDebugSettings] = useState<MapSpriteDebugSettings>(
    () => {
      if (!isMapSpriteDebugEnvironment || typeof window === 'undefined') {
        return DEFAULT_MAP_SPRITE_DEBUG_SETTINGS
      }

      const storedSettings = parseMapSpriteDebugSettings(
        window.localStorage.getItem(MAP_SPRITE_DEBUG_STORAGE_KEY)
      )

      return storedSettings ?? DEFAULT_MAP_SPRITE_DEBUG_SETTINGS
    }
  )

  const currentUser = users.find((user: User) => user.id === authUser?.id)

  // Helper to get display name and email
  const getDisplayName = () => {
    // Prefer currentUser.name if available (comes from LiveStore user record)
    if (currentUser?.name) return currentUser.name
    // Fall back to authUser email
    if (authUser) return authUser.email
    return 'User'
  }

  const getEmail = () => {
    if (authUser) return authUser.email
    return ''
  }

  // Handle dropdown toggle with position calculation
  const handleToggleDropdown = () => {
    if (!showDropdown && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropdownPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      })
    }
    setShowDropdown(!showDropdown)
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!isDebugPanelOpen) {
      return
    }

    const handleDebugPanelClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (debugPanelRef.current?.contains(target) || debugButtonRef.current?.contains(target)) {
        return
      }

      setIsDebugPanelOpen(false)
    }

    document.addEventListener('mousedown', handleDebugPanelClickOutside)
    return () => document.removeEventListener('mousedown', handleDebugPanelClickOutside)
  }, [isDebugPanelOpen])

  useEffect(() => {
    if (onboarding.uiPolicy.showAttendantRail) {
      if (onboarding.uiPolicy.railFadingIn) {
        setIsRailVisible(false)
        const timeoutId = window.setTimeout(() => {
          setIsRailVisible(true)
        }, 40)

        return () => {
          window.clearTimeout(timeoutId)
        }
      }

      setIsRailVisible(true)
      return
    }

    setIsRailVisible(false)
    closeAttendant()
  }, [closeAttendant, onboarding.uiPolicy.railFadingIn, onboarding.uiPolicy.showAttendantRail])

  const showOnlyJarvisDuringCampfire =
    onboarding.isActive && (onboarding.phase === 'campfire' || onboarding.phase === 'not_started')
  const showDevDebugPanel = isMapSpriteDebugEnvironment && fullBleed
  const isInitialFogEnabled = !onboarding.isFogDismissed
  const isInitialFogCurrentlyVisible = onboarding.uiPolicy.showFogOverlay && isInitialFogEnabled

  useEffect(() => {
    if (showOnlyJarvisDuringCampfire && activeAttendantId === 'marvin') {
      closeAttendant()
    }
  }, [activeAttendantId, closeAttendant, showOnlyJarvisDuringCampfire])

  const handleFeedbackClick = () => {
    const surveyId = import.meta.env.VITE_POSTHOG_FEEDBACK_SURVEY_ID
    if (!surveyId) {
      // Fallback: open email client if survey not configured
      window.location.href = 'mailto:team@sociotechnica.org?subject=LifeBuild%20Feedback'
      return
    }
    if (posthog) {
      // PostHog API-triggered surveys: this event causes the survey popup to display
      posthog.capture('survey shown', { $survey_id: surveyId })
    } else {
      // PostHog not available, fallback to email
      window.location.href = 'mailto:team@sociotechnica.org?subject=LifeBuild%20Feedback'
    }
  }

  const handleInitialFogToggle = () => {
    if (isInitialFogEnabled) {
      onboarding.dismissFogOverlay()
      return
    }

    onboarding.resetFogOverlay()
  }

  const updateSanctuaryScale = (nextValue: number) => {
    setMapSpriteDebugSettings(current => ({
      ...current,
      sanctuaryScale: clampSpriteScale(nextValue),
    }))
  }

  const updateWorkshopScale = (nextValue: number) => {
    setMapSpriteDebugSettings(current => ({
      ...current,
      workshopScale: clampSpriteScale(nextValue),
    }))
  }

  const updateTreeScale = (treeId: MapTreeSpriteId, nextValue: number) => {
    setMapSpriteDebugSettings(current => ({
      ...current,
      treeScales: {
        ...current.treeScales,
        [treeId]: clampSpriteScale(nextValue),
      },
    }))
  }

  const updateSanctuaryOrigin = (axis: keyof MapSpriteOrigin, nextValue: number) => {
    setMapSpriteDebugSettings(current => ({
      ...current,
      sanctuaryOrigin: {
        ...current.sanctuaryOrigin,
        [axis]: clampSpriteOrigin(nextValue),
      },
    }))
  }

  const updateWorkshopOrigin = (axis: keyof MapSpriteOrigin, nextValue: number) => {
    setMapSpriteDebugSettings(current => ({
      ...current,
      workshopOrigin: {
        ...current.workshopOrigin,
        [axis]: clampSpriteOrigin(nextValue),
      },
    }))
  }

  const updateTreeOrigin = (
    treeId: MapTreeSpriteId,
    axis: keyof MapSpriteOrigin,
    nextValue: number
  ) => {
    setMapSpriteDebugSettings(current => ({
      ...current,
      treeOrigins: {
        ...current.treeOrigins,
        [treeId]: {
          ...(current.treeOrigins[treeId] ?? { x: 0, y: 0 }),
          [axis]: clampSpriteOrigin(nextValue),
        },
      },
    }))
  }

  useEffect(() => {
    if (!showDevDebugPanel || typeof window === 'undefined') {
      return
    }

    window.localStorage.setItem(
      MAP_SPRITE_DEBUG_STORAGE_KEY,
      JSON.stringify(mapSpriteDebugSettings)
    )
  }, [mapSpriteDebugSettings, showDevDebugPanel])

  // Always use h-dvh flex layout for a full-viewport shell.
  // h-dvh (dynamic viewport height) accounts for iOS Safari address bar.
  const outerClasses = 'h-dvh flex flex-col overflow-hidden text-[#2f2b27] leading-relaxed'

  // fullHeight mode: full width content area
  // noScroll mode: children handle their own scrolling (e.g. project views with scrollable columns)
  // normal mode: content scrolls within the main area
  const mainClasses = fullHeight
    ? `flex-1 min-h-0 w-full ${noScroll ? 'overflow-hidden' : 'overflow-y-auto'}`
    : 'flex-1 min-h-0 overflow-y-auto'

  const contentClasses = fullBleed
    ? 'h-full w-full'
    : fullHeight
      ? 'h-full'
      : 'max-w-[1200px] mx-auto p-2'

  return (
    <div
      className={outerClasses}
      style={{
        background:
          'radial-gradient(circle at 15% 20%, rgba(255, 255, 255, 0.8), transparent 40%), #f5f3f0',
      }}
    >
      <MapSpriteDebugProvider value={mapSpriteDebugSettings}>
        {onboarding.uiPolicy.showTaskQueue && <TaskQueuePanel />}
        {onboarding.uiPolicy.showAttendantRail && (
          <div
            className={`transition-opacity duration-700 ${isRailVisible ? 'opacity-100' : 'opacity-0'}`}
          >
            <AttendantRail
              activeAttendantId={activeAttendantId}
              onAttendantClick={toggleAttendant}
              visibleAttendantIds={showOnlyJarvisDuringCampfire ? ['jarvis'] : undefined}
              statusPip={isAuthenticated ? <LiveStoreStatus /> : undefined}
              notifications={
                onboarding.uiPolicy.showMarvinNotification ? { marvin: true } : undefined
              }
            />
          </div>
        )}
        {onboarding.uiPolicy.showAttendantRail && <AttendantChatPanel />}

        <div className='fixed right-3 top-3 z-[130]'>
          {isAuthenticated ? (
            <button
              ref={buttonRef}
              type='button'
              onClick={handleToggleDropdown}
              className='bg-[#2f2b27] text-[#faf9f7] p-3 rounded-full font-semibold text-sm shadow-[0_8px_16px_rgba(0,0,0,0.24)] cursor-pointer border-none hover:bg-[#3f3b37] transition-colors duration-[160ms]'
              title={getDisplayName()}
              data-testid='user-menu-button'
            >
              {getInitials(currentUser?.name || getDisplayName())}
            </button>
          ) : (
            <Link
              to={ROUTES.LOGIN}
              className='inline-block bg-[#2f2b27] text-[#faf9f7] py-2 px-4 rounded-xl font-semibold text-sm no-underline hover:bg-[#3f3b37] transition-colors duration-[160ms]'
            >
              Sign in
            </Link>
          )}
        </div>

        {showDevDebugPanel ? (
          <div className='fixed right-20 top-4 z-[140]' data-testid='dev-debug-panel'>
            <button
              ref={debugButtonRef}
              type='button'
              onClick={() => setIsDebugPanelOpen(open => !open)}
              className='rounded-md border border-[#d8cab3] bg-[#fff8ec]/90 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#6f5b44] shadow-[0_6px_12px_rgba(0,0,0,0.12)] backdrop-blur transition-colors hover:bg-[#fff5e5]'
              data-testid='dev-debug-panel-button'
              aria-expanded={isDebugPanelOpen}
              aria-controls='dev-debug-panel-controls'
            >
              Debug
            </button>
            {isDebugPanelOpen ? (
              <div
                id='dev-debug-panel-controls'
                ref={debugPanelRef}
                className='absolute right-0 top-full mt-2 w-[320px] rounded-xl border border-[#d8cab3] bg-[#fff8ec]/95 p-3 shadow-[0_12px_24px_rgba(0,0,0,0.2)] backdrop-blur'
              >
                <p className='text-xs font-semibold text-[#2f2b27]'>Map Debug Controls</p>
                <label className='mt-2 flex cursor-pointer items-center justify-between gap-3 text-xs text-[#5f4a36]'>
                  <span>Initial fog enabled</span>
                  <input
                    type='checkbox'
                    checked={isInitialFogEnabled}
                    onChange={handleInitialFogToggle}
                    data-testid='dev-debug-toggle-fog'
                  />
                </label>
                <p className='mt-1 text-[11px] text-[#8b6f55]'>
                  Visible now: {isInitialFogCurrentlyVisible ? 'yes' : 'no'} ({onboarding.phase})
                </p>

                <div className='mt-3 border-t border-[#dfd0bc] pt-2'>
                  <p className='text-[11px] font-semibold text-[#6f5b44]'>Landmark scale</p>
                  <label className='mt-2 block text-[11px] text-[#5f4a36]'>
                    <div className='flex items-center justify-between'>
                      <span>Sanctuary</span>
                      <span>{mapSpriteDebugSettings.sanctuaryScale.toFixed(2)}x</span>
                    </div>
                    <input
                      type='range'
                      min={MIN_SPRITE_SCALE}
                      max={MAX_SPRITE_SCALE}
                      step='0.01'
                      value={mapSpriteDebugSettings.sanctuaryScale}
                      onChange={event => updateSanctuaryScale(Number(event.target.value))}
                      data-testid='dev-debug-slider-sanctuary-scale'
                      className='mt-1 w-full'
                    />
                  </label>
                  <div className='mt-1 grid grid-cols-2 gap-2 text-[11px] text-[#5f4a36]'>
                    <label className='block'>
                      <span className='block'>Sanctuary X</span>
                      <input
                        type='number'
                        min={MIN_SPRITE_ORIGIN}
                        max={MAX_SPRITE_ORIGIN}
                        step='0.01'
                        value={mapSpriteDebugSettings.sanctuaryOrigin.x}
                        onChange={event => updateSanctuaryOrigin('x', Number(event.target.value))}
                        data-testid='dev-debug-input-sanctuary-origin-x'
                        className='mt-1 w-full rounded border border-[#d8cab3] bg-white px-1.5 py-1 text-[11px]'
                      />
                    </label>
                    <label className='block'>
                      <span className='block'>Sanctuary Y</span>
                      <input
                        type='number'
                        min={MIN_SPRITE_ORIGIN}
                        max={MAX_SPRITE_ORIGIN}
                        step='0.01'
                        value={mapSpriteDebugSettings.sanctuaryOrigin.y}
                        onChange={event => updateSanctuaryOrigin('y', Number(event.target.value))}
                        data-testid='dev-debug-input-sanctuary-origin-y'
                        className='mt-1 w-full rounded border border-[#d8cab3] bg-white px-1.5 py-1 text-[11px]'
                      />
                    </label>
                  </div>
                  <label className='mt-2 block text-[11px] text-[#5f4a36]'>
                    <div className='flex items-center justify-between'>
                      <span>Workshop</span>
                      <span>{mapSpriteDebugSettings.workshopScale.toFixed(2)}x</span>
                    </div>
                    <input
                      type='range'
                      min={MIN_SPRITE_SCALE}
                      max={MAX_SPRITE_SCALE}
                      step='0.01'
                      value={mapSpriteDebugSettings.workshopScale}
                      onChange={event => updateWorkshopScale(Number(event.target.value))}
                      data-testid='dev-debug-slider-workshop-scale'
                      className='mt-1 w-full'
                    />
                  </label>
                  <div className='mt-1 grid grid-cols-2 gap-2 text-[11px] text-[#5f4a36]'>
                    <label className='block'>
                      <span className='block'>Workshop X</span>
                      <input
                        type='number'
                        min={MIN_SPRITE_ORIGIN}
                        max={MAX_SPRITE_ORIGIN}
                        step='0.01'
                        value={mapSpriteDebugSettings.workshopOrigin.x}
                        onChange={event => updateWorkshopOrigin('x', Number(event.target.value))}
                        data-testid='dev-debug-input-workshop-origin-x'
                        className='mt-1 w-full rounded border border-[#d8cab3] bg-white px-1.5 py-1 text-[11px]'
                      />
                    </label>
                    <label className='block'>
                      <span className='block'>Workshop Y</span>
                      <input
                        type='number'
                        min={MIN_SPRITE_ORIGIN}
                        max={MAX_SPRITE_ORIGIN}
                        step='0.01'
                        value={mapSpriteDebugSettings.workshopOrigin.y}
                        onChange={event => updateWorkshopOrigin('y', Number(event.target.value))}
                        data-testid='dev-debug-input-workshop-origin-y'
                        className='mt-1 w-full rounded border border-[#d8cab3] bg-white px-1.5 py-1 text-[11px]'
                      />
                    </label>
                  </div>
                  <p className='mt-1 text-[10px] text-[#8b6f55]'>
                    Origin values are tile-space offsets (X = horizontal, Y = depth).
                  </p>
                </div>

                <div className='mt-3 border-t border-[#dfd0bc] pt-2'>
                  <p className='text-[11px] font-semibold text-[#6f5b44]'>Tree scale</p>
                  {MAP_TREE_SPRITE_CONFIGS.map(tree => {
                    const treeScale =
                      mapSpriteDebugSettings.treeScales[tree.id] ?? tree.defaultScale
                    const treeOrigin =
                      mapSpriteDebugSettings.treeOrigins[tree.id] ?? tree.defaultOrigin

                    return (
                      <div key={tree.id} className='mt-2 text-[11px] text-[#5f4a36]'>
                        <label className='block'>
                          <div className='flex items-center justify-between'>
                            <span>{tree.label}</span>
                            <span>{treeScale.toFixed(2)}x</span>
                          </div>
                          <input
                            type='range'
                            min={MIN_SPRITE_SCALE}
                            max={MAX_SPRITE_SCALE}
                            step='0.01'
                            value={treeScale}
                            onChange={event => updateTreeScale(tree.id, Number(event.target.value))}
                            data-testid={`dev-debug-slider-${tree.id}-scale`}
                            className='mt-1 w-full'
                          />
                        </label>
                        <div className='mt-1 grid grid-cols-2 gap-2'>
                          <label className='block'>
                            <span className='block'>X</span>
                            <input
                              type='number'
                              min={MIN_SPRITE_ORIGIN}
                              max={MAX_SPRITE_ORIGIN}
                              step='0.01'
                              value={treeOrigin.x}
                              onChange={event =>
                                updateTreeOrigin(tree.id, 'x', Number(event.target.value))
                              }
                              data-testid={`dev-debug-input-${tree.id}-origin-x`}
                              className='mt-1 w-full rounded border border-[#d8cab3] bg-white px-1.5 py-1 text-[11px]'
                            />
                          </label>
                          <label className='block'>
                            <span className='block'>Y</span>
                            <input
                              type='number'
                              min={MIN_SPRITE_ORIGIN}
                              max={MAX_SPRITE_ORIGIN}
                              step='0.01'
                              value={treeOrigin.y}
                              onChange={event =>
                                updateTreeOrigin(tree.id, 'y', Number(event.target.value))
                              }
                              data-testid={`dev-debug-input-${tree.id}-origin-y`}
                              className='mt-1 w-full rounded border border-[#d8cab3] bg-white px-1.5 py-1 text-[11px]'
                            />
                          </label>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {showDropdown && (
          <div
            ref={dropdownRef}
            className='fixed min-w-64 max-w-80 bg-white rounded-md shadow-lg py-1 z-[9999] border border-[#e8e4de]'
            style={{
              top: `${dropdownPosition.top}px`,
              right: `${dropdownPosition.right}px`,
            }}
          >
            <div className='px-4 py-2 text-sm text-[#2f2b27] border-b border-[#e8e4de]'>
              <div className='font-medium truncate'>{getDisplayName()}</div>
              <div className='text-[#8b8680] truncate'>{getEmail()}</div>
            </div>
            {isCurrentUserAdmin(authUser) && (
              <Link
                to={ROUTES.ADMIN}
                onClick={() => setShowDropdown(false)}
                className='block px-4 py-2 text-sm text-[#2f2b27] hover:bg-black/[0.04] no-underline'
              >
                Admin
              </Link>
            )}
            <button
              type='button'
              onClick={async () => {
                await logout()
                setShowDropdown(false)
              }}
              className='block w-full text-left px-4 py-2 text-sm text-[#2f2b27] hover:bg-black/[0.04] bg-transparent border-none cursor-pointer'
            >
              Sign out
            </button>
          </div>
        )}

        <button
          type='button'
          onClick={handleFeedbackClick}
          className='fixed bottom-4 right-4 z-[120] border border-[#d8cab3] bg-[#fff8ec]/95 text-sm font-medium text-[#5f4a36] cursor-pointer px-3 py-2 rounded-lg shadow-[0_8px_16px_rgba(0,0,0,0.18)] backdrop-blur transition-all duration-[160ms] hover:bg-white'
          aria-label='Send feedback'
        >
          Feedback
        </button>

        <main className={`${mainClasses} ${fullBleed ? '' : 'p-3.5'}`}>
          <div className={contentClasses}>{children}</div>
        </main>
      </MapSpriteDebugProvider>
    </div>
  )
}
