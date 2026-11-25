// Logo — the PayOnce mark, design fix round 2 (2026-11-24).
// A "paid once" motif as crisp SVG code, never a raster image: an ember
// gradient tile, a once-loop (an almost-closed ring, open at the top right)
// and a bold check that cuts through the ring and out of the gap — one
// payment, one loop, done. Used everywhere: top nav, dashboard sidebar,
// footer, favicon (public/favicon.svg is the same mark, standalone).
// Palette is the polished sunset direction only: ember #C2410C → #9A3412 →
// #7C2D12, white ink. No new colours.
import { useId } from 'react'

export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const gid = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role="img"
      aria-label="PayOnce logo — a check inside a once-loop"
      focusable="false"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#C2410C" />
          <stop offset="55%" stopColor="#9A3412" />
          <stop offset="100%" stopColor="#7C2D12" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill={`url(#${gid})`} />
      <rect x="1.5" y="1.5" width="45" height="45" rx="13" fill="none" stroke="#FFFFFF" strokeOpacity="0.25" strokeWidth="1" />
      {/* Once-loop: a ring open at the top right (dash gap sits at -48°..0°,
          i.e. upper right). Circumference 2π·13 ≈ 81.7. Thicker than round 2
          (r 12.5, 3.6) — at 32px the ring was invisible; the loop is the
          "once" in the mark, so it must read at display size. */}
      <circle
        cx="24"
        cy="24"
        r="13"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeDasharray="71.2 10.5"
      />
      {/* The check: stem rises through the ring and out of its gap. */}
      <path
        d="M 17.5 24.5 L 22 29 L 31.5 19.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Logo({
  size = 32,
  dark = false,
  className = '',
}: {
  size?: number
  /** dark = on the sunset sky / deep-ember band (white wordmark). */
  dark?: boolean
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      <span
        className={`text-[17px] font-medium tracking-[-0.01em] ${dark ? 'text-white' : 'text-ink'}`}
        style={{ fontSize: size >= 32 ? undefined : Math.max(14, size * 0.55) }}
      >
        PayOnce
      </span>
    </span>
  )
}
