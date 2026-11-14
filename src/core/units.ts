// Numbers as a person reads them, in meters or in feet and inches. The scene
// is always in meters; only what the viewer prints changes.

export type Units = 'm' | 'ft'

const MINUS = '−'
const INCH = 0.0254

// 3.42 m, or 11′ 3″ to the nearest inch.
export function formatLength(meters: number, units: Units): string {
  if (units === 'm') return `${sign(meters)}${Math.abs(meters).toFixed(2)} m`
  return `${sign(meters)}${feetInches(Math.abs(meters))}`
}

// 4.20 × 3.80 m, or 13′ 9″ × 12′ 6″.
export function formatSize(sizes: number[], units: Units): string {
  if (units === 'm') return `${sizes.map((s) => s.toFixed(2)).join(' × ')} m`
  return sizes.map(feetInches).join(' × ')
}

// 12.3 m², or 132 ft².
export function formatArea(squareMeters: number, units: Units): string {
  if (units === 'm') return `${squareMeters.toFixed(1)} m²`
  return `${Math.round(squareMeters / (0.3048 * 0.3048))} ft²`
}

// A floor level the way a drawing writes it: ±0.00, −0.75, +0.30.
export function formatLevel(meters: number, units: Units): string {
  const rounded = units === 'm' ? Math.round(meters * 100) : Math.round(meters / INCH)
  if (rounded === 0) return units === 'm' ? '±0.00 m' : '±0″'
  return `${meters > 0 ? '+' : MINUS}${units === 'm' ? `${Math.abs(meters).toFixed(2)} m` : feetInches(Math.abs(meters))}`
}

function sign(value: number): string {
  return value < 0 && Math.abs(value) >= 0.005 ? MINUS : ''
}

function feetInches(meters: number): string {
  const inches = Math.round(meters / INCH)
  const feet = Math.floor(inches / 12)
  const rest = inches % 12
  return feet === 0 ? `${rest}″` : `${feet}′ ${rest}″`
}
