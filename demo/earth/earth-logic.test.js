import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOrbit, rotateOrbit, zoomOrbit, smoothOrbit, orbitPosition,
  MIN_DISTANCE, MAX_DISTANCE, POLAR_MARGIN, SMOOTHING_SECONDS
} from "./earth-logic.js";

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("createOrbit starts inside the allowed range", () => {
  const orbit = createOrbit();
  assert.ok(orbit.distance > MIN_DISTANCE && orbit.distance < MAX_DISTANCE);
  assert.ok(orbit.polar > POLAR_MARGIN && orbit.polar < Math.PI - POLAR_MARGIN);
});

test("rotateOrbit adds the deltas and does not mutate its input", () => {
  const orbit = { azimuth: 1, polar: 1, distance: 3 };
  assert.deepEqual(rotateOrbit(orbit, 0.5, -0.25), { azimuth: 1.5, polar: 0.75, distance: 3 });
  assert.deepEqual(orbit, { azimuth: 1, polar: 1, distance: 3 });
});

test("rotateOrbit clamps polar at both poles, azimuth is unbounded", () => {
  const orbit = { azimuth: 0, polar: 1, distance: 3 };
  assert.equal(rotateOrbit(orbit, 0, -10).polar, POLAR_MARGIN);
  assert.equal(rotateOrbit(orbit, 0, 10).polar, Math.PI - POLAR_MARGIN);
  assert.equal(rotateOrbit(orbit, -100, 0).azimuth, -100);
});

test("rotateOrbit rejects non-finite deltas", () => {
  assert.throws(() => rotateOrbit(createOrbit(), NaN, 0), TypeError);
  assert.throws(() => rotateOrbit(createOrbit(), 0, Infinity), TypeError);
});

test("zoomOrbit scales the distance and clamps at the limits", () => {
  const orbit = { azimuth: 0, polar: 1, distance: 3 };
  assert.equal(zoomOrbit(orbit, 2).distance, 6);
  assert.equal(zoomOrbit(orbit, 1).distance, 3);
  assert.equal(zoomOrbit(orbit, 1e-6).distance, MIN_DISTANCE);
  assert.equal(zoomOrbit(orbit, 1e6).distance, MAX_DISTANCE);
});

test("zoomOrbit rejects zero, negative and non-finite factors", () => {
  for (const factor of [0, -1, NaN, Infinity]) {
    assert.throws(() => zoomOrbit(createOrbit(), factor), RangeError);
  }
});

test("smoothOrbit stays put at delta 0, converges for a large delta", () => {
  const current = { azimuth: 0, polar: 1, distance: 2 };
  const target = { azimuth: 2, polar: 2, distance: 6 };
  assert.deepEqual(smoothOrbit(current, target, 0), current);
  const arrived = smoothOrbit(current, target, 100);
  close(arrived.azimuth, 2);
  close(arrived.polar, 2);
  close(arrived.distance, 6);
});

test("smoothOrbit is frame-rate independent", () => {
  const current = { azimuth: 0, polar: 1, distance: 2 };
  const target = { azimuth: 2, polar: 2, distance: 6 };
  const oneStep = smoothOrbit(current, target, SMOOTHING_SECONDS);
  let manySteps = current;
  for (let step = 0; step < 10; step++) manySteps = smoothOrbit(manySteps, target, SMOOTHING_SECONDS / 10);
  close(manySteps.azimuth, oneStep.azimuth);
  close(manySteps.distance, oneStep.distance);
  close(oneStep.azimuth, 2 * (1 - 1 / Math.E));
});

test("smoothOrbit rejects negative and non-finite deltas", () => {
  const orbit = createOrbit();
  assert.throws(() => smoothOrbit(orbit, orbit, -0.1), RangeError);
  assert.throws(() => smoothOrbit(orbit, orbit, NaN), RangeError);
});

test("orbitPosition maps the angles to three.js axes", () => {
  const onZ = orbitPosition({ azimuth: 0, polar: Math.PI / 2, distance: 3 });
  close(onZ.x, 0); close(onZ.y, 0); close(onZ.z, 3);
  const onX = orbitPosition({ azimuth: Math.PI / 2, polar: Math.PI / 2, distance: 3 });
  close(onX.x, 3); close(onX.y, 0); close(onX.z, 0);
  const above = orbitPosition({ azimuth: 1, polar: 0, distance: 2 });
  close(above.x, 0); close(above.y, 2); close(above.z, 0);
});

test("orbitPosition keeps the requested distance", () => {
  const position = orbitPosition({ azimuth: 2.3, polar: 0.7, distance: 4.5 });
  close(Math.hypot(position.x, position.y, position.z), 4.5);
});
