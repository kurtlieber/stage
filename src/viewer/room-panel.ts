import { roomFacts, roomName, type OpeningFact } from '../core/room-facts.ts'
import type { Scene } from '../core/schema.ts'
import { formatArea, formatLength, formatLevel, formatSize, type Units } from '../core/units.ts'

// The room panel: the facts about the current room, its doors and windows,
// and its places. Read-only, like the rest of the viewer.

export interface PanelActions {
  goToRoom(id: string): void
  walkTo(placeId: string): void
  placeName(id: string): string
  setUnits(units: Units): void
}

const KIND: Record<OpeningFact['type'], string> = { door: 'Door', slider: 'Sliding door', opening: 'Opening', window: 'Window' }

export function renderRoomPanel(panel: HTMLElement, scene: Scene | undefined, roomId: string | undefined, units: Units, actions: PanelActions) {
  const facts = scene && roomId ? roomFacts(scene, roomId) : undefined
  // Drawn afresh each time, so focus inside it would fall to the page: it
  // goes back to the units switch, or else to the room's name.
  const focused = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement) ? document.activeElement : undefined
  const refocus = focused && (focused.closest('.units') ? 'units' : 'title')
  panel.classList.toggle('hidden', !facts)
  panel.replaceChildren()
  if (!scene || !facts) return
  const add = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, text?: string, className?: string) => {
    const element = document.createElement(tag)
    if (text !== undefined) element.textContent = text
    if (className) element.className = className
    parent.append(element)
    return element
  }

  const title = add(panel, 'h2', facts.name)
  title.id = 'room-title'
  title.tabIndex = -1
  add(panel, 'div', facts.level, 'room-level')

  const list = add(panel, 'dl', undefined, 'facts')
  const fact = (term: string, value: string) => {
    add(list, 'dt', term)
    add(list, 'dd', value)
  }
  fact(facts.overall ? 'Overall size' : 'Size', formatSize(facts.size, units))
  fact('Area', formatArea(facts.area, units))
  fact('Ceiling', facts.ceiling === undefined ? 'Open to the sky' : formatLength(facts.ceiling, units))
  fact('Floor level', formatLevel(facts.floor, units))

  if (facts.openings.length > 0) {
    add(panel, 'h3', 'Doors and windows')
    const openings = add(panel, 'ul', undefined, 'openings')
    for (const opening of facts.openings) {
      const row = add(openings, 'li')
      const what = add(row, 'span', KIND[opening.type], 'what')
      if (opening.type !== 'window') {
        const other = opening.to ? scene.rooms.find((r) => r.id === opening.to) : undefined
        what.append(' to ')
        if (other) {
          const link = add(what, 'button', roomName(other), 'link')
          link.type = 'button'
          link.addEventListener('click', () => actions.goToRoom(other.id))
        } else what.append('outside')
      }
      const size = formatSize([opening.width, opening.height], units)
      add(row, 'span', opening.sill === undefined ? size : `${size}, sill ${formatLength(opening.sill, units)}`, 'dims')
    }
  }

  if (facts.places.length > 0) {
    add(panel, 'h3', 'Places')
    const places = add(panel, 'ul', undefined, 'places')
    for (const id of facts.places) {
      const button = add(add(places, 'li'), 'button', actions.placeName(id), 'link')
      button.type = 'button'
      button.addEventListener('click', () => actions.walkTo(id))
    }
  }

  const switcher = add(panel, 'div', undefined, 'units')
  switcher.setAttribute('role', 'group')
  switcher.setAttribute('aria-label', 'Units')
  for (const [value, label] of [['m', 'Meters'], ['ft', 'Feet and inches']] as const) {
    const button = add(switcher, 'button', value === 'm' ? 'm' : 'ft-in')
    button.type = 'button'
    button.title = `${label} (U)`
    button.setAttribute('aria-pressed', String(units === value))
    button.addEventListener('click', () => actions.setUnits(value))
  }
  if (refocus === 'units') switcher.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
  else if (refocus === 'title') title.focus()
}
