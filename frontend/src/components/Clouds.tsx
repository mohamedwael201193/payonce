// Cloud layers — original, generated in the browser with SVG feTurbulence.
// P2 §5.2: "hand-drawn SVG clouds" / inline SVG with feTurbulence + blur.
// No asset from the reference video is used. Three layers (back / mid / front)
// with different speeds; the front layer overlaps the dashboard bottom.
// Respects prefers-reduced-motion (static when reduced).

import { useReducedMotion } from 'framer-motion'

function CloudLayer({
  seed,
  opacity,
  className,
  style,
}: {
  seed: number
  opacity: number
  className?: string
  style?: React.CSSProperties
}) {
  const id = `cloud-${seed}`
  return (
    <svg
      className={className}
      style={style}
      aria-hidden="true"
      preserveAspectRatio="none"
      viewBox="0 0 1200 220"
    >
      <defs>
        <filter id={id} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.03"
            numOctaves="4"
            seed={seed}
            result="noise"
          />
          <feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0" result="whiteNoise" />
          <feGaussianBlur in="whiteNoise" stdDeviation="18" result="soft" />
          <feComponentTransfer in="soft" result="clouds">
            <feFuncA type="linear" slope="1.6" intercept="-0.25" />
          </feComponentTransfer>
          <feComposite in="clouds" in2="SourceGraphic" operator="in" />
        </filter>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="45%" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.95" />
        </linearGradient>
      </defs>
      <rect width="1200" height="220" fill={`url(#${id}-fade)`} filter={`url(#${id})`} opacity={opacity} />
    </svg>
  )
}

export function CloudBanks({ className = '' }: { className?: string }) {
  const reduceMotion = useReducedMotion()
  // Back layer drifts slowly (parallax 0.35x per P2 §5.1); front is static.
  // With reduced motion everything is static (P2 §5.6).
  return (
    <div className={`pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden ${className}`} aria-hidden="true">
      <div
        className="absolute inset-x-0 bottom-0 h-[220px]"
        style={reduceMotion ? undefined : { animation: 'cloud-drift 90s linear infinite alternate' }}
      >
        <CloudLayer seed={7} opacity={0.55} className="absolute inset-x-0 bottom-0 h-[220px] w-full" />
      </div>
      <CloudLayer seed={21} opacity={0.8} className="absolute inset-x-0 bottom-[-30px] h-[220px] w-full" />
      <CloudLayer seed={42} opacity={1} className="absolute inset-x-0 bottom-[-70px] h-[220px] w-full" />
      <style>{`@keyframes cloud-drift { from { transform: translateX(-1.5%); } to { transform: translateX(1.5%); } }`}</style>
    </div>
  )
}
