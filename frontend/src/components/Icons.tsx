import type { ReactNode } from 'react'

// The frame's icons (CK-82): the design chat's hand-drawn inline SVGs, path
// for path from the mockup (handoff §7) — a 24-unit view box, a 1.8 stroke
// (2 for the menu and the chevron), round caps and joins, drawn in
// `currentColor`. Every one is decorative: `aria-hidden`, beside words that
// name what it marks, or inside a control whose label does. No icon set is
// added.

export type IconName = 'groups' | 'gatherings' | 'you' | 'menu' | 'gear' | 'plan' | 'signOut' | 'chevron'

const ICONS: Record<IconName, { paths: ReactNode; width?: number }> = {
  groups: {
    paths: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
        <circle cx="17" cy="9" r="2.6" />
        <path d="M15.6 14.3c2.3.1 4.2 1.7 4.9 4.7" />
      </>
    ),
  },
  gatherings: {
    paths: (
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="3" />
        <path d="M3.5 10h17M8 3v4M16 3v4" />
        <path d="M8 14h3" />
      </>
    ),
  },
  you: {
    paths: (
      <>
        <circle cx="12" cy="8.5" r="3.6" />
        <path d="M5 20c.9-3.7 3.8-5.8 7-5.8s6.1 2.1 7 5.8" />
      </>
    ),
  },
  menu: { paths: <path d="M4 7h16M4 12h16M4 17h16" />, width: 2 },
  gear: {
    paths: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
      </>
    ),
  },
  plan: {
    paths: (
      <>
        <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
        <path d="M3 10h18M7 15h4" />
      </>
    ),
  },
  signOut: {
    paths: (
      <>
        <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
        <path d="M10 16l-4-4 4-4M6 12h10" />
      </>
    ),
  },
  chevron: { paths: <path d="M9 5l7 7-7 7" />, width: 2 },
}

export function Icon({ name, className = 'ico' }: { name: IconName; className?: string }) {
  const icon = ICONS[name]
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={icon.width ?? 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icon.paths}
    </svg>
  )
}
