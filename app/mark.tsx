/**
 * The mark is relation one of Allen's interval algebra, `precedes`.
 * One interval ruled through, the next one open, the instant of the switch between them.
 */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-label="Tredecim">
      <line x1="12" y1="3.5" x2="12" y2="20.5" stroke="var(--ink)" strokeWidth=".8" strokeDasharray="2 2" opacity=".5" />
      <line x1="3" y1="8.5" x2="14" y2="8.5" stroke="var(--closed)" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="10" y1="15.5" x2="21" y2="15.5" stroke="var(--open)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  )
}
