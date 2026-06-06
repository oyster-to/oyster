import { test, expect } from 'vitest';
import { renderLegacyStream } from './legacy/legacy-engine.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { takeOnMe } from '../songs/take-on-me.js';

const SONGS = { kids, risingSun, electricFeel, heartbeats, digitalLove, memoryReboot, takeOnMe };

for (const [name, song] of Object.entries(SONGS)) {
  test(`legacy stream for ${name} is non-empty and deterministic`, () => {
    const a = renderLegacyStream(song);
    const b = renderLegacyStream(song);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
}

test('kids steady state contains the post-fill crash flourish at bar 0', () => {
  const stream = renderLegacyStream(kids);
  expect(stream.some(k => k.startsWith('[0,0,') && k.includes('"crash"'))).toBe(true);
});

// Content-lock: trips if anyone edits the frozen reference's behaviour (eventKey shape, resolution logic, etc.)
test('content lock: kids stream shape is frozen (guards the reference itself)', () => {
  const stream = renderLegacyStream(kids);
  expect(stream.length).toBe(1060);
  expect(stream[0]).toBe('[0,0,"bass","bass",null,null,"F#2",null,2]');
});
