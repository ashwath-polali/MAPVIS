import type { ReactNode } from 'react'

export type IconName =
  | 'brush'
  | 'poly'
  | 'rect'
  | 'bucket'
  | 'eraser'
  | 'pick'
  | 'occ'
  | 'cut'
  | 'sparkle'
  | 'wand'
  | 'walk'
  | 'heal'
  | 'flag'
  | 'pin'
  | 'export'
  | 'dots'
  | 'wave'
  | 'eye'
  | 'eyeoff'
  | 'x'
  | 'check'
  | 'door'
  | 'pencil'
  | 'align-l'
  | 'align-hc'
  | 'align-r'
  | 'align-t'
  | 'align-vc'
  | 'align-b'

/* the six align marks: a rule, and two bars sitting against it, which is the
 * one drawing everyone already reads without a label */
const alignH = (rule: number, a: [number, number], b: [number, number]) => (
  <>
    <path d={`M${rule} 2 L${rule} 14`} opacity="0.55" />
    <rect x={a[0]} y="4" width={a[1]} height="3" rx="0.6" />
    <rect x={b[0]} y="9" width={b[1]} height="3" rx="0.6" />
  </>
)
const alignV = (rule: number, a: [number, number], b: [number, number]) => (
  <>
    <path d={`M2 ${rule} L14 ${rule}`} opacity="0.55" />
    <rect x="4" y={a[0]} width="3" height={a[1]} rx="0.6" />
    <rect x="9" y={b[0]} width="3" height={b[1]} rx="0.6" />
  </>
)

const D: Record<IconName, ReactNode> = {
  'align-l': alignH(3, [3, 9], [3, 5]),
  'align-r': alignH(13, [4, 9], [8, 5]),
  'align-hc': alignH(8, [3.5, 9], [5.5, 5]),
  'align-t': alignV(3, [3, 9], [3, 5]),
  'align-b': alignV(13, [4, 9], [8, 5]),
  'align-vc': alignV(8, [3.5, 9], [5.5, 5]),
  brush: (
    <>
      <path d="M11.2 3.1l1.7 1.7-5.2 5.2-1.7-1.7z" />
      <path d="M6 8.3c-1 .7-1.3 2-1.8 3.5 1.5-.5 2.8-.8 3.5-1.8" />
    </>
  ),
  poly: (
    <>
      <path d="M3.5 11.5L5.5 4l7.5 2-1.5 6.5z" />
      <circle cx="3.5" cy="11.5" r="1.1" />
      <circle cx="5.5" cy="4" r="1.1" />
      <circle cx="13" cy="6" r="1.1" />
      <circle cx="11.5" cy="12.5" r="1.1" />
    </>
  ),
  rect: <rect x="3" y="4" width="10" height="8" rx="0.5" />,
  bucket: (
    <>
      <path d="M3.2 7.4l4.6-4.2 5 4.6-4.6 4.2z" />
      <path d="M12.9 10c-.7 1-1.1 1.6-1.1 2.2a1.1 1.1 0 002.2 0c0-.6-.4-1.2-1.1-2.2z" />
    </>
  ),
  eraser: (
    <>
      <path d="M9.6 3.4l3 3-5.2 5.2h-3l-1.5-1.5z" />
      <path d="M4 12.6h8.5" />
    </>
  ),
  pick: (
    <>
      <path d="M12.9 3.1a1.5 1.5 0 00-2.2 0l-1.3 1.4" />
      <path d="M8.2 4.9l2.9 2.9" />
      <path d="M10.2 5.6l-5.5 5.6-.6 2 2-.6 5.5-5.6" />
    </>
  ),
  occ: (
    <>
      <path d="M3.5 3.5h6v6h-6z" />
      <path d="M6.5 6.5h6v6h-6z" fill="var(--bg)" />
    </>
  ),
  cut: (
    <>
      <circle cx="4.4" cy="11.9" r="1.6" />
      <circle cx="11.6" cy="11.9" r="1.6" />
      <path d="M5.6 10.7L12 3.2" />
      <path d="M10.4 10.7L4 3.2" />
    </>
  ),
  sparkle: <path d="M8 2.4l1.5 3.9 3.9 1.5-3.9 1.5L8 13.2 6.5 9.3 2.6 7.8l3.9-1.5z" />,
  wand: (
    <>
      <path d="M3.2 12.8l6.2-6.2 1.4 1.4-6.2 6.2z" />
      <path d="M11.6 2.6l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" />
      <path d="M13.2 8.4l.3.9.9.3-.9.3-.3.9-.3-.9-.9-.3.9-.3z" />
    </>
  ),
  walk: (
    <>
      <circle cx="8.6" cy="3.4" r="1.3" />
      <path d="M8.4 5.2l-1.6 3 1.9 1.6.4 3.4" />
      <path d="M6.8 8.2l-2 1.2" />
      <path d="M8.7 6.4l2.4.8" />
      <path d="M6.4 13.2l1.2-2.6" />
    </>
  ),
  heal: (
    <>
      <rect x="2.6" y="6" width="10.8" height="4" rx="2" transform="rotate(-45 8 8)" />
      <path d="M6.8 6.8l2.4 2.4M9.2 6.8L6.8 9.2" />
    </>
  ),
  flag: (
    <>
      <path d="M4.5 13.5v-10" />
      <path d="M4.5 3.8h7l-1.8 2.4 1.8 2.4h-7" />
    </>
  ),
  pin: (
    <>
      <path d="M8 13.4S3.8 9.2 3.8 6.4a4.2 4.2 0 018.4 0c0 2.8-4.2 7-4.2 7z" />
      <circle cx="8" cy="6.4" r="1.4" />
    </>
  ),
  export: (
    <>
      <path d="M8 2.6v7" />
      <path d="M5.2 7l2.8 2.8L10.8 7" />
      <path d="M3 10.6v2.8h10v-2.8" />
    </>
  ),
  dots: (
    <>
      <circle cx="3.6" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.4" cy="8" r="1" fill="currentColor" />
    </>
  ),
  wave: (
    <>
      <path d="M2.5 9.6c1.4 0 1.4-1.4 2.8-1.4s1.4 1.4 2.7 1.4 1.4-1.4 2.8-1.4 1.4 1.4 2.7 1.4" />
      <path d="M2.5 12.2c1.4 0 1.4-1.4 2.8-1.4s1.4 1.4 2.7 1.4 1.4-1.4 2.8-1.4 1.4 1.4 2.7 1.4" />
      <path d="M6.5 5.8a3.4 3.4 0 016.6 1" />
    </>
  ),
  eye: (
    <>
      <path d="M2.4 8s2-3.6 5.6-3.6S13.6 8 13.6 8s-2 3.6-5.6 3.6S2.4 8 2.4 8z" />
      <circle cx="8" cy="8" r="1.7" />
    </>
  ),
  eyeoff: (
    <>
      <path d="M3.4 4.2c-.6.7-1 1.4-1 1.4S4.4 11.6 8 11.6c.7 0 1.3-.1 1.9-.4M6.7 4.6A6 6 0 018 4.4C11.6 4.4 13.6 8 13.6 8s-.5.9-1.4 1.8" transform="translate(0 -0.4)" />
      <path d="M3 3l10 10" />
    </>
  ),
  x: (
    <>
      <path d="M4.4 4.4l7.2 7.2" />
      <path d="M11.6 4.4l-7.2 7.2" />
    </>
  ),
  check: <path d="M3.4 8.6l3 3 6.2-7" />,
  door: (
    <>
      <path d="M4.6 13.2V3.6a.7.7 0 01.7-.7h5.4a.7.7 0 01.7.7v9.6" />
      <path d="M3 13.2h10" />
      <circle cx="9.6" cy="8.3" r="0.8" fill="currentColor" />
    </>
  ),
  pencil: (
    <>
      <path d="M10.8 2.9l2.3 2.3-7.4 7.4-3 .7.7-3z" />
      <path d="M9.4 4.3l2.3 2.3" />
    </>
  ),
}

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {D[name]}
    </svg>
  )
}
