'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const canvas = import('../src/canvas.mjs');

test('canvas zoom keeps the world point under the pointer fixed, including at zoom limits', async () => {
  const { zoomAt } = await canvas;
  const view = { x: -450, y: 180, scale: 0.65 };
  const pointer = { x: 320, y: 90 };
  const world = { x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale };
  for (const scale of [0.3, 1, 5, 0.000001, 1000000]) {
    const next = zoomAt(view, scale, pointer);
    assert.ok(Number.isFinite(next.scale) && next.scale > 0);
    assert.ok(Math.abs(next.x + world.x * next.scale - pointer.x) < 1e-8);
    assert.ok(Math.abs(next.y + world.y * next.scale - pointer.y) < 1e-8);
    const restored = zoomAt(next, view.scale, pointer);
    assert.ok(Math.abs(restored.x - view.x) < 1e-8);
    assert.ok(Math.abs(restored.y - view.y) < 1e-8);
  }
});

test('fit includes displaced cards in both dimensions with padding and a centered view', async () => {
  const { fitView } = await canvas;
  for (const bounds of [
    { x: -1500, y: -800, width: 2900, height: 2100 },
    { x: 400, y: -100, width: 300, height: 320 }
  ]) {
    for (const size of [{ width: 550, height: 270 }, { width: 900, height: 640 }]) {
      const view = fitView(bounds, size);
      const left = view.x + bounds.x * view.scale;
      const top = view.y + bounds.y * view.scale;
      const right = size.width - left - bounds.width * view.scale;
      const bottom = size.height - top - bounds.height * view.scale;
      assert.ok(left >= 32 - 1e-8 && top >= 32 - 1e-8);
      assert.ok(Math.abs(left - right) < 1e-8 && Math.abs(top - bottom) < 1e-8);
      assert.ok(view.scale <= 1);
    }
  }
});

test('initial canvas layout wraps into a non-overlapping two-dimensional chronological path', async () => {
  const { initialPosition } = await canvas;
  const positions = Array.from({ length: 12 }, (_, index) => initialPosition(index));
  assert.ok(new Set(positions.map(point => point.y)).size > 1);
  assert.ok(positions[1].x > positions[0].x && positions[4].x < positions[3].x);
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      assert.ok(Math.abs(positions[i].x - positions[j].x) >= 300 || Math.abs(positions[i].y - positions[j].y) >= 330);
    }
    if (i) assert.ok(positions[i].x === positions[i - 1].x || positions[i].y === positions[i - 1].y);
  }
});
