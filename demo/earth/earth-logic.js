// Orbit-Kamera um den Ursprung. Einheiten: Erdradius = 1, Winkel in Radiant.
// azimuth dreht um +Y (0 = Kamera auf +Z), polar ist der Winkel zur +Y-Achse.
export const MIN_DISTANCE = 1.4;
export const MAX_DISTANCE = 8;
// Abstand zu den Polen, damit die Kamera nie über Kopf kippt.
export const POLAR_MARGIN = 0.15;
// Zeitkonstante der Glättung: so viele Sekunden bis ca. 63 % des Wegs.
export const SMOOTHING_SECONDS = 0.12;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function requireFinite(name, value) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite number`);
}

export function createOrbit() {
  return { azimuth: 0.6, polar: 1.25, distance: 3.2 };
}

export function rotateOrbit(orbit, azimuthDelta, polarDelta) {
  requireFinite('azimuthDelta', azimuthDelta);
  requireFinite('polarDelta', polarDelta);
  return {
    ...orbit,
    azimuth: orbit.azimuth + azimuthDelta,
    polar: clamp(orbit.polar + polarDelta, POLAR_MARGIN, Math.PI - POLAR_MARGIN)
  };
}

export function zoomOrbit(orbit, factor) {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('factor must be a positive number');
  return { ...orbit, distance: clamp(orbit.distance * factor, MIN_DISTANCE, MAX_DISTANCE) };
}

// Bewegt current exponentiell auf target zu, unabhängig von der Bildrate.
export function smoothOrbit(current, target, deltaSeconds) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError('deltaSeconds must be >= 0');
  const blend = 1 - Math.exp(-deltaSeconds / SMOOTHING_SECONDS);
  const approach = key => current[key] + (target[key] - current[key]) * blend;
  return { azimuth: approach('azimuth'), polar: approach('polar'), distance: approach('distance') };
}

export function orbitPosition(orbit) {
  const ring = orbit.distance * Math.sin(orbit.polar);
  return {
    x: ring * Math.sin(orbit.azimuth),
    y: orbit.distance * Math.cos(orbit.polar),
    z: ring * Math.cos(orbit.azimuth)
  };
}
