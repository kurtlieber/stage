// A sliding glass door. Without `tracks` it is equal panels on two rails,
// the middle ones slid open so people can walk through. With `tracks` it is
// a multi-track stacking door: one panel per rail, all of them slid over the
// fixed panel at the `stack` end, opening the rest of the width. The viewer
// draws this layout and the walker is stopped by the closed panels, so both
// agree on where the gap is.

// Panels taller than this get a fixed transom above them instead.
export const PANEL_HEIGHT = 2.7
// Two rails sit this far either side of the wall's centerline; more rails
// sit twice this far apart, as long as the wall is thick enough.
export const RAIL_OFFSET = 0.03
const PANEL_MAX = 1.5

export interface Panel {
  // Where the panel sits when closed, along the opening from its start.
  from: number
  to: number
  rail: number
  open: boolean
  // Where it is drawn: closed panels in place, open ones over a neighbour.
  at: number
}

export interface SliderLayout {
  panels: Panel[]
  // How many rails the panels run on.
  rails: number
  // The clear walk-through, along the opening from its start.
  gap: { from: number; to: number }
  // Height of the moving panels; glass above that is fixed.
  panelTop: number
}

// An opening's own fields: `tracks` and `stack` from the scene.
export interface SliderOptions {
  tracks?: number
  stack?: 'start' | 'end'
}

export function sliderLayout(width: number, height: number, options: SliderOptions = {}): SliderLayout {
  const panelTop = height > PANEL_HEIGHT + 0.3 ? PANEL_HEIGHT : height
  if (options.tracks !== undefined) return stacking(width, panelTop, options.tracks, options.stack ?? 'start')
  const count = Math.max(2, Math.ceil(width / PANEL_MAX))
  const panelWidth = width / count
  // Two panels: the first slides over the second. Three: the middle one over
  // the first. Four or more: the middle pair part, each over its neighbour.
  const half = Math.floor(count / 2)
  const open = count === 2 ? [0] : count === 3 ? [1] : [half - 1, half]
  const over = (i: number) => (count === 2 ? 1 : count === 3 ? 0 : i === half - 1 ? i - 1 : i + 1)
  const panels: Panel[] = []
  for (let i = 0; i < count; i++) {
    const isOpen = open.includes(i)
    panels.push({ from: i * panelWidth, to: (i + 1) * panelWidth, rail: i % 2, open: isOpen, at: (isOpen ? over(i) : i) * panelWidth })
  }
  const gap = { from: open[0] * panelWidth, to: (open[open.length - 1] + 1) * panelWidth }
  return { panels, rails: 2, gap, panelTop }
}

// One panel per rail. The panel at the stack end is fixed on rail 0; the
// others stand open, stacked over it on rails 1, 2 and on.
function stacking(width: number, panelTop: number, tracks: number, stack: 'start' | 'end'): SliderLayout {
  const panelWidth = width / tracks
  const fixedAt = stack === 'start' ? 0 : width - panelWidth
  const panels: Panel[] = []
  for (let rail = 0; rail < tracks; rail++) {
    const i = stack === 'start' ? rail : tracks - 1 - rail
    panels.push({ from: i * panelWidth, to: (i + 1) * panelWidth, rail, open: rail > 0, at: fixedAt })
  }
  const gap = stack === 'start' ? { from: panelWidth, to: width } : { from: 0, to: width - panelWidth }
  return { panels, rails: tracks, gap, panelTop }
}

// Distance between neighbouring rails in a wall of `thickness`: twice
// RAIL_OFFSET, closer when that many rails would not fit inside the wall.
export function railSpacing(rails: number, thickness: number): number {
  if (rails < 2) return 0
  if (rails === 2) return 2 * RAIL_OFFSET
  return Math.min(2 * RAIL_OFFSET, Math.max(0.01, thickness - 0.04) / (rails - 1))
}

// How far a rail sits from the wall's centerline, to the left of the wall
// (the side a floor plan calls left as the wall runs from its start).
// Rails are evenly spaced and centered; with two, rail 0 is at +RAIL_OFFSET.
export function railOffset(rail: number, rails: number, thickness: number): number {
  return ((rails - 1) / 2 - rail) * railSpacing(rails, thickness)
}
