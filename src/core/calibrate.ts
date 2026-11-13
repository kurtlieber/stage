// Fitting a level's plan drawing to the plan. Two points on the drawing and
// the distance between them, read off one of its dimension lines, give the
// drawing's scale; where the first point stands in the plan gives its
// origin. Every other dimension on the drawing is then a check: measured
// with that scale, it should come out at its labeled length.
//
// The drawing is assumed square to the plan, as plans are drawn: x runs
// right and y runs up the page, so a pixel's y grows the other way.

export type Pixel = [number, number]
export type PlanPoint = [number, number]

export interface Calibration {
  /** Pixels per meter. */
  scale: number
  /** The pixel at plan [0, 0]. */
  origin: Pixel
}

export interface Check {
  a: Pixel
  b: Pixel
  /** The labeled length, in meters. */
  distance: number
}

export interface CheckResult extends Check {
  /** The length the calibration gives, in meters. */
  measured: number
  /** (measured - distance) / distance: 0.01 is 1% long. */
  error: number
}

const pixels = (a: Pixel, b: Pixel) => Math.hypot(b[0] - a[0], b[1] - a[1])

/** The scale and origin from two points `distance` meters apart, with `a` at plan point `at`. */
export function calibrate(a: Pixel, b: Pixel, distance: number, at: PlanPoint = [0, 0]): Calibration {
  if (!(distance > 0)) throw new Error('the distance between the two points must be more than 0 meters')
  const span = pixels(a, b)
  if (!(span > 0)) throw new Error('the two points are the same pixel; pick two ends of a dimension')
  const scale = span / distance
  return { scale, origin: [a[0] - at[0] * scale, a[1] + at[1] * scale] }
}

/** The length in meters between two pixels. */
export function measure(calibration: Calibration, a: Pixel, b: Pixel): number {
  return pixels(a, b) / calibration.scale
}

/** A labeled dimension measured with the calibration, and how far off it is. */
export function checkDistance(calibration: Calibration, check: Check): CheckResult {
  if (!(check.distance > 0)) throw new Error('a check distance must be more than 0 meters')
  const measured = measure(calibration, check.a, check.b)
  return { ...check, measured, error: (measured - check.distance) / check.distance }
}

/** Where a pixel of the drawing is in the plan, in meters. */
export function toPlan(calibration: Calibration, pixel: Pixel): PlanPoint {
  const { scale, origin } = calibration
  return [(pixel[0] - origin[0]) / scale, (origin[1] - pixel[1]) / scale]
}

/** The pixel of the drawing under a plan point. */
export function toPixel(calibration: Calibration, point: PlanPoint): Pixel {
  const { scale, origin } = calibration
  return [origin[0] + point[0] * scale, origin[1] - point[1] * scale]
}
