import { useFrame, useLoader } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { hexToWorld } from '../hex/math.js'
import type { HexCoord } from '../hex/types.js'

// Vertex shader — pass through UVs
const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// Fragment shader — base layer with white/black background removal
const baseFragmentShader = `
  uniform sampler2D uTexture;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D(uTexture, vUv);
    float brightness = (tex.r + tex.g + tex.b) / 3.0;
    float alpha = tex.a;
    // Fade near-white backgrounds
    alpha *= 1.0 - smoothstep(0.82, 0.95, brightness);
    // Fade near-black backgrounds
    alpha *= smoothstep(0.02, 0.12, brightness);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(tex.rgb, alpha);
  }
`

// Fragment shader — animated layer, just uses PNG alpha directly
const frameFragmentShader = `
  uniform sampler2D uTexture;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D(uTexture, vUv);
    if (tex.a < 0.01) discard;
    gl_FragColor = tex;
  }
`

interface AnimatedSpriteProps {
  coord: HexCoord
  /** Static base image URL (e.g. logs) */
  baseUrl: string
  /** Array of image URLs for each animation frame (e.g. flames) */
  frames: string[]
  /** Frames per second for the animation */
  fps?: number
  /** Scale of the base layer */
  baseScale?: number
  /** Scale of the animated layer */
  frameScale?: number
}

const HEX_SIZE = 1.0
const TILT = -Math.PI / 2 + 35 * (Math.PI / 180)

export function AnimatedSprite({
  coord,
  baseUrl,
  frames,
  fps = 10,
  baseScale = 2.0,
  frameScale = 2.0,
}: AnimatedSpriteProps) {
  const baseTexture = useLoader(THREE.TextureLoader, baseUrl)
  const frameTextures = useLoader(THREE.TextureLoader, frames)
  const [x, z] = hexToWorld(coord, HEX_SIZE)
  // Randomized playback order for more natural animation
  const playOrder = useMemo(() => {
    const indices = Array.from({ length: frameTextures.length }, (_, i) => i)
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[indices[i], indices[j]] = [indices[j], indices[i]]
    }
    return indices
  }, [frameTextures.length])
  const frameRef = useRef({ elapsed: 0, index: 0 })

  const baseMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTexture: { value: baseTexture } },
        vertexShader,
        fragmentShader: baseFragmentShader,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: true,
      }),
    [baseTexture]
  )

  const frameMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uTexture: { value: frameTextures[0] } },
        vertexShader,
        fragmentShader: frameFragmentShader,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: true,
      }),
    [frameTextures]
  )

  useFrame((_, delta) => {
    const state = frameRef.current
    state.elapsed += delta
    const frameDuration = 1 / fps
    if (state.elapsed >= frameDuration) {
      state.elapsed -= frameDuration
      state.index = (state.index + 1) % playOrder.length
      frameMaterial.uniforms.uTexture!.value = frameTextures[playOrder[state.index]]
    }
  })

  const baseAspect = baseTexture.image ? baseTexture.image.width / baseTexture.image.height : 1
  const frameAspect = frameTextures[0]?.image
    ? frameTextures[0].image.width / frameTextures[0].image.height
    : 1

  // Position the flame layer above the base layer
  const baseY = baseScale / 2
  const flameY = baseScale * 0.6 + frameScale / 2 - 0.08

  return (
    <group position={[x, 0, z + HEX_SIZE * 0.4]}>
      {/* Base layer (logs) */}
      <mesh position={[0, baseY, 0]} rotation={[TILT, 0, 0]} material={baseMaterial}>
        <planeGeometry args={[baseScale * baseAspect, baseScale]} />
      </mesh>
      {/* Animated layer (flames) */}
      <mesh position={[0, flameY, 0]} rotation={[TILT, 0, 0]} material={frameMaterial}>
        <planeGeometry args={[frameScale * frameAspect, frameScale]} />
      </mesh>
    </group>
  )
}
