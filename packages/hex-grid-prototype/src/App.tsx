import { Canvas } from '@react-three/fiber'
import { Suspense, useEffect, useState } from 'react'
import { AnimatedSprite } from './components/AnimatedSprite.js'
import { CameraRig } from './components/CameraRig.js'
import { HexGrid } from './components/HexGrid.js'
import { MapSprite } from './components/MapSprite.js'
import { Unit } from './components/Unit.js'
import { useGameState } from './store/gameState.js'
import { useShaderParams, defaultShaderParams, presets } from './store/shaderParams.js'
import { useKMParams, useShaderMode, kmPresets } from './store/kmParams.js'
import { useSpriteState } from './store/spriteState.js'

const panelBodyStyle: React.CSSProperties = {
  color: '#5c4a32',
  fontFamily: 'monospace',
  fontSize: 13,
  background: 'rgba(232, 213, 181, 0.92)',
  padding: '8px 12px',
  borderRadius: 6,
  lineHeight: 1.6,
  border: '1px solid #c4a87a',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
}

const dotStyle: React.CSSProperties = {
  position: 'absolute',
  top: 9,
  left: 11,
  width: 10,
  height: 10,
  borderRadius: '50%',
  background: '#8b7355',
  cursor: 'pointer',
  zIndex: 2,
}

const sliderRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  margin: '2px 0',
}

const labelStyle: React.CSSProperties = {
  minWidth: 90,
  fontSize: 11,
}

const valueStyle: React.CSSProperties = {
  minWidth: 40,
  textAlign: 'right',
  fontSize: 11,
}

const sectionStyle: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: '1px solid #c4a87a',
}

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 'bold',
  textTransform: 'uppercase' as const,
  letterSpacing: 1,
  marginBottom: 2,
  cursor: 'pointer',
  userSelect: 'none' as const,
}

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}

function Slider({ label, value, min, max, step, onChange }: SliderProps) {
  const decimals = step >= 1 ? 1 : 3
  return (
    <div
      style={sliderRowStyle}
      onWheel={e => {
        e.stopPropagation()
        const delta = (e.deltaY > 0 ? -step : step) * 0.1
        const next = Math.min(max, Math.max(min, parseFloat((value + delta).toFixed(10))))
        onChange(next)
      }}
    >
      <span style={labelStyle}>{label}</span>
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: 100, accentColor: '#8b7355' }}
      />
      <span style={valueStyle}>{value.toFixed(decimals)}</span>
    </div>
  )
}

function CameraControls() {
  const elevation = useGameState(s => s.cameraElevation)
  const setElevation = useGameState(s => s.setCameraElevation)

  return (
    <Slider label='Elevation' value={elevation} min={5} max={90} step={1} onChange={setElevation} />
  )
}

function ShaderControls() {
  const params = useShaderParams()
  const set = useShaderParams(s => s.set)

  const [scalesOpen, setScalesOpen] = useState(true)
  const [strengthsOpen, setStrengthsOpen] = useState(true)
  const [edgesOpen, setEdgesOpen] = useState(true)

  return (
    <>
      <div style={sectionStyle}>
        <div style={sliderRowStyle}>
          <span style={labelStyle}>Preset</span>
          <select
            value=''
            onChange={e => {
              const preset = presets[e.target.value]
              if (preset) set(preset)
            }}
            style={selectStyle}
          >
            <option value='' disabled>
              Choose a preset...
            </option>
            {Object.keys(presets).map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle} onClick={() => setScalesOpen(!scalesOpen)}>
          {scalesOpen ? '▾' : '▸'} Noise Scales
        </div>
        {scalesOpen && (
          <>
            <Slider
              label='Region'
              value={params.regionScale}
              min={0.01}
              max={0.3}
              step={0.005}
              onChange={v => set({ regionScale: v })}
            />
            <Slider
              label='Region 2'
              value={params.region2Scale}
              min={0.01}
              max={0.3}
              step={0.005}
              onChange={v => set({ region2Scale: v })}
            />
            <Slider
              label='Blotch'
              value={params.blotchScale}
              min={0.05}
              max={1.0}
              step={0.01}
              onChange={v => set({ blotchScale: v })}
            />
            <Slider
              label='Blotch 2'
              value={params.blotch2Scale}
              min={0.05}
              max={1.0}
              step={0.01}
              onChange={v => set({ blotch2Scale: v })}
            />
            <Slider
              label='Wet Edge'
              value={params.wetEdgeScale}
              min={0.01}
              max={0.5}
              step={0.005}
              onChange={v => set({ wetEdgeScale: v })}
            />
            <Slider
              label='Grain'
              value={params.grainScale}
              min={0.5}
              max={15.0}
              step={0.1}
              onChange={v => set({ grainScale: v })}
            />
            <Slider
              label='Fiber X'
              value={params.fiberScaleX}
              min={0.5}
              max={20.0}
              step={0.1}
              onChange={v => set({ fiberScaleX: v })}
            />
            <Slider
              label='Fiber Y'
              value={params.fiberScaleY}
              min={0.5}
              max={20.0}
              step={0.1}
              onChange={v => set({ fiberScaleY: v })}
            />
            <Slider
              label='Speckle'
              value={params.speckleScale}
              min={1.0}
              max={30.0}
              step={0.5}
              onChange={v => set({ speckleScale: v })}
            />
          </>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle} onClick={() => setStrengthsOpen(!strengthsOpen)}>
          {strengthsOpen ? '▾' : '▸'} Strengths
        </div>
        {strengthsOpen && (
          <>
            <Slider
              label='Sage'
              value={params.sageStrength}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ sageStrength: v })}
            />
            <Slider
              label='Stain'
              value={params.stainStrength}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ stainStrength: v })}
            />
            <Slider
              label='Pool Light'
              value={params.poolLightStrength}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ poolLightStrength: v })}
            />
            <Slider
              label='Pool Dark'
              value={params.poolDarkStrength}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ poolDarkStrength: v })}
            />
            <Slider
              label='Wet Edge'
              value={params.wetEdgeStrength}
              min={0}
              max={0.2}
              step={0.005}
              onChange={v => set({ wetEdgeStrength: v })}
            />
            <Slider
              label='Grain'
              value={params.grainIntensity}
              min={0}
              max={0.15}
              step={0.002}
              onChange={v => set({ grainIntensity: v })}
            />
            <Slider
              label='Fiber'
              value={params.fiberIntensity}
              min={0}
              max={0.1}
              step={0.002}
              onChange={v => set({ fiberIntensity: v })}
            />
            <Slider
              label='Speckle'
              value={params.speckleIntensity}
              min={0}
              max={0.1}
              step={0.002}
              onChange={v => set({ speckleIntensity: v })}
            />
          </>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle} onClick={() => setEdgesOpen(!edgesOpen)}>
          {edgesOpen ? '▾' : '▸'} Hex Edges
        </div>
        {edgesOpen && (
          <>
            <Slider
              label='Strength'
              value={params.edgeStrength}
              min={0}
              max={0.8}
              step={0.01}
              onChange={v => set({ edgeStrength: v })}
            />
            <Slider
              label='Width'
              value={params.edgeWidth}
              min={0.01}
              max={0.2}
              step={0.005}
              onChange={v => set({ edgeWidth: v })}
            />
          </>
        )}
      </div>

      <div style={{ ...sectionStyle, display: 'flex', gap: 8 }}>
        <button
          onClick={() => {
            const { set: _, ...values } = useShaderParams.getState()
            navigator.clipboard.writeText(JSON.stringify(values, null, 2))
          }}
          style={buttonStyle}
        >
          Copy values
        </button>
      </div>
    </>
  )
}

const selectStyle: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  padding: '2px 4px',
  background: '#ede0c8',
  border: '1px solid #a8906e',
  borderRadius: 3,
  color: '#5c4a32',
  fontFamily: 'monospace',
  cursor: 'pointer',
}

const buttonStyle: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: '#c4a87a',
  border: '1px solid #a8906e',
  borderRadius: 3,
  color: '#5c4a32',
  cursor: 'pointer',
  fontFamily: 'monospace',
}

function KMControls() {
  const params = useKMParams()
  const set = useKMParams(s => s.set)

  const [pigmentsOpen, setPigmentsOpen] = useState(true)
  const [paintOpen, setPaintOpen] = useState(true)
  const [textureOpen, setTextureOpen] = useState(true)
  const [edgesOpen, setEdgesOpen] = useState(true)

  return (
    <>
      <div style={sectionStyle}>
        <div style={sliderRowStyle}>
          <span style={labelStyle}>Preset</span>
          <select
            value=''
            onChange={e => {
              const preset = kmPresets[e.target.value]
              if (preset) set(preset)
            }}
            style={selectStyle}
          >
            <option value='' disabled>
              Choose a preset...
            </option>
            {Object.keys(kmPresets).map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle} onClick={() => setPigmentsOpen(!pigmentsOpen)}>
          {pigmentsOpen ? '▾' : '▸'} Pigments
        </div>
        {pigmentsOpen && (
          <>
            <Slider
              label='Yellow Ochre'
              value={params.ochreAmount}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ ochreAmount: v })}
            />
            <Slider
              label='Burnt Sienna'
              value={params.siennaAmount}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ siennaAmount: v })}
            />
            <Slider
              label='Sap Green'
              value={params.greenAmount}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ greenAmount: v })}
            />
            <Slider
              label='Raw Umber'
              value={params.umberAmount}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ umberAmount: v })}
            />
          </>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle} onClick={() => setPaintOpen(!paintOpen)}>
          {paintOpen ? '▾' : '▸'} Paint Layer
        </div>
        {paintOpen && (
          <>
            <Slider
              label='Thickness'
              value={params.baseThickness}
              min={0.1}
              max={5.0}
              step={0.1}
              onChange={v => set({ baseThickness: v })}
            />
            <Slider
              label='Variation'
              value={params.thicknessVariation}
              min={0}
              max={1.0}
              step={0.01}
              onChange={v => set({ thicknessVariation: v })}
            />
            <Slider
              label='Edge Dark'
              value={params.edgeDarkening}
              min={0}
              max={0.3}
              step={0.005}
              onChange={v => set({ edgeDarkening: v })}
            />
          </>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle} onClick={() => setTextureOpen(!textureOpen)}>
          {textureOpen ? '▾' : '▸'} Texture
        </div>
        {textureOpen && (
          <>
            <Slider
              label='Region'
              value={params.regionScale}
              min={0.01}
              max={0.2}
              step={0.005}
              onChange={v => set({ regionScale: v })}
            />
            <Slider
              label='Blotch'
              value={params.blotchScale}
              min={0.05}
              max={0.5}
              step={0.01}
              onChange={v => set({ blotchScale: v })}
            />
            <Slider
              label='Grain'
              value={params.grainScale}
              min={0.5}
              max={10.0}
              step={0.1}
              onChange={v => set({ grainScale: v })}
            />
            <Slider
              label='Grain Str'
              value={params.grainIntensity}
              min={0}
              max={0.1}
              step={0.002}
              onChange={v => set({ grainIntensity: v })}
            />
          </>
        )}
      </div>

      <div style={sectionStyle}>
        <div style={sectionHeaderStyle} onClick={() => setEdgesOpen(!edgesOpen)}>
          {edgesOpen ? '▾' : '▸'} Hex Edges
        </div>
        {edgesOpen && (
          <>
            <Slider
              label='Strength'
              value={params.edgeStrength}
              min={0}
              max={0.8}
              step={0.01}
              onChange={v => set({ edgeStrength: v })}
            />
            <Slider
              label='Width'
              value={params.edgeWidth}
              min={0.01}
              max={0.2}
              step={0.005}
              onChange={v => set({ edgeWidth: v })}
            />
          </>
        )}
      </div>

      <div style={{ ...sectionStyle, display: 'flex', gap: 8 }}>
        <button
          onClick={() => {
            const { set: _, ...values } = useKMParams.getState()
            navigator.clipboard.writeText(JSON.stringify(values, null, 2))
          }}
          style={buttonStyle}
        >
          Copy values
        </button>
      </div>
    </>
  )
}

const campfireFlames = Array.from(
  { length: 15 },
  (_, i) => `/sprites/campfire/flame-${String(i).padStart(2, '0')}.png`
)

export function App() {
  const [panelOpen, setPanelOpen] = useState(true)
  const [logsScale, setLogsScale] = useState(0.9)
  const [flameScale, setFlameScale] = useState(1.6)
  const mode = useShaderMode(s => s.mode)
  const toggle = useShaderMode(s => s.toggle)
  const sprites = useSpriteState(s => s.sprites)
  const heldSpriteId = useSpriteState(s => s.heldSpriteId)
  const cancel = useSpriteState(s => s.cancel)

  const heldSprite = heldSpriteId ? sprites.find(s => s.id === heldSpriteId) : null

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        toggle()
      }
      if (e.key === 'Escape' && heldSpriteId) {
        cancel()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [toggle, heldSpriteId, cancel])

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Canvas
        orthographic
        camera={{ position: [0, 40, 35], zoom: 1, near: 0.1, far: 1000 }}
        gl={{ antialias: true }}
      >
        {/* Warm, soft lighting — no harsh shadows */}
        <ambientLight color='#fff5e6' intensity={0.7} />
        <directionalLight position={[10, 20, 10]} color='#ffe8cc' intensity={0.6} />
        <hemisphereLight color='#c9dde6' groundColor='#d4b896' intensity={0.4} />

        <CameraRig />
        <HexGrid />
        <Unit />
        <Suspense fallback={null}>
          {sprites.map(sp => (
            <MapSprite key={sp.id} coord={sp.coord} url={sp.url} scale={sp.scale} />
          ))}
          <AnimatedSprite
            coord={{ q: 1, r: -1, s: 0 }}
            baseUrl='/sprites/campfire/logs.png'
            frames={campfireFlames}
            fps={10}
            baseScale={logsScale}
            frameScale={flameScale}
          />
        </Suspense>
      </Canvas>

      {/* Held sprite indicator */}
      {heldSprite && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            color: '#5c4a32',
            fontFamily: 'monospace',
            fontSize: 13,
            background: 'rgba(232, 213, 181, 0.95)',
            padding: '6px 14px',
            borderRadius: 6,
            border: '2px solid #8b7355',
            userSelect: 'none',
            cursor: 'pointer',
          }}
          onClick={cancel}
        >
          Holding: <strong>{heldSprite.id}</strong> — click a hex to place, Esc to cancel
        </div>
      )}

      {/* Shader mode indicator */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          color: '#5c4a32',
          fontFamily: 'monospace',
          fontSize: 11,
          background: 'rgba(232, 213, 181, 0.85)',
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid #c4a87a',
          userSelect: 'none',
        }}
      >
        {mode === 'parchment' ? 'Parchment' : 'Kubelka-Munk'} [Tab]
      </div>

      {/* GitHub repo link */}
      <a
        href='https://github.com/sociotechnica-org/lifebuild/tree/main/packages/hex-grid-prototype'
        target='_blank'
        rel='noopener noreferrer'
        style={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          color: '#5c4a32',
          fontFamily: 'monospace',
          fontSize: 11,
          background: 'rgba(232, 213, 181, 0.85)',
          padding: '4px 8px',
          borderRadius: 4,
          border: '1px solid #c4a87a',
          textDecoration: 'none',
        }}
      >
        GitHub
      </a>

      <div style={{ position: 'absolute', top: 16, left: 16 }}>
        {panelOpen && (
          <div style={panelBodyStyle}>
            <div>Arrow keys: pan | Tab: toggle shader</div>
            <div>Scroll: zoom</div>
            <div>Click hex: select + move unit</div>
            <CameraControls />
            <div style={sectionStyle}>
              <div style={sectionHeaderStyle}>Campfire</div>
              <Slider
                label='Logs'
                value={logsScale}
                min={0.5}
                max={5.0}
                step={0.1}
                onChange={setLogsScale}
              />
              <Slider
                label='Flames'
                value={flameScale}
                min={0.5}
                max={5.0}
                step={0.1}
                onChange={setFlameScale}
              />
            </div>
            {mode === 'parchment' ? <ShaderControls /> : <KMControls />}
          </div>
        )}
        <div style={dotStyle} onClick={() => setPanelOpen(o => !o)} />
      </div>
    </div>
  )
}
