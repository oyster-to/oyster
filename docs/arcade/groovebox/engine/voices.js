import * as Tone from 'tone';
import { DEFAULT_INSTRUMENTS, DEFAULT_KIT, validateInstrument, slotKey } from './instruments.js';

/**
 * voices.js — instrument data → sounding Tone nodes.
 *
 * The synthesis recipes live in engine/instruments.js as neutral patch JSON
 * (DEFAULT_INSTRUMENTS / DEFAULT_KIT). This file owns the ONE adapter from
 * that vocabulary to Tone:
 *   compileSynthPatch(inst)  — pure: patch → build plan (parity-testable)
 *   createVoiceForType(...)  — plan → connected Tone nodes
 *   trigger(...)             — scheduler events → triggerAttackRelease calls
 *
 * Voice shapes:
 *   drums  → { byNote: { [gmNote]: { synth, trig } }, dispose() }
 *   bass   → { bass, trig, dispose() }
 *   chords → { chordSyn, chordFilter, trig, dispose() }
 *   melody → { lead, trig, dispose() }
 * (Pitched lanes keep their legacy named props — index.js sets melody tone
 * via voice.lead. disposeLane prefers voice.dispose().)
 */

const BRIGHT_OPEN = 18000;   // transparent lowpass base for pitched brightness inserts

const CTOR_BY_ARCHETYPE = {
  membrane: 'MembraneSynth',
  noise:    'NoiseSynth',
  mono:     'MonoSynth',
  poly:     'PolySynth',
};

/**
 * compileSynthPatch(inst) → pure build plan:
 * { ctor, options, postVolume, filter, trig }
 * - options: constructor/set() options (volume folded in where the legacy code
 *   passed it to the constructor; postVolume where it assigned .volume.value)
 * - trig: { sig: 'note'|'noise', note?, dur?, velocity? } — how trigger() fires it
 */
export function compileSynthPatch(inst) {
  const p = inst.patch;
  const plan = {
    ctor: CTOR_BY_ARCHETYPE[p.archetype],
    options: {},
    postVolume: undefined,
    filter: p.filter ? { type: p.filter.type, freq: p.filter.freq } : null,
    trig: {
      sig: p.archetype === 'noise' ? 'noise' : 'note',
      note: p.trigger?.note,
      dur: p.trigger?.dur,
      velocity: p.trigger?.velocity,
    },
  };
  const osc = p.oscillator
    ? { type: p.oscillator.shape, ...(p.oscillator.width !== undefined ? { width: p.oscillator.width } : {}) }
    : null;

  if (p.archetype === 'membrane') {
    plan.options = {
      ...(p.volume !== undefined ? { volume: p.volume } : {}),
      ...(p.pitch ? { pitchDecay: p.pitch.pitchDecay, octaves: p.pitch.octaves } : {}),
    };
  } else if (p.archetype === 'noise') {
    plan.options = {
      ...(p.volume !== undefined ? { volume: p.volume } : {}),
      ...(p.envelope ? { envelope: { ...p.envelope } } : {}),
    };
  } else if (p.archetype === 'mono') {
    plan.options = {
      ...(osc ? { oscillator: osc } : {}),
      ...(p.envelope ? { envelope: { ...p.envelope } } : {}),
      ...(p.filterEnvelope ? { filterEnvelope: { ...p.filterEnvelope } } : {}),
    };
    plan.postVolume = p.volume;          // legacy assigned bass volume after construction
  } else if (p.archetype === 'poly') {
    plan.options = {                      // applied via synth.set()
      ...(osc ? { oscillator: osc } : {}),
      ...(p.envelope ? { envelope: { ...p.envelope } } : {}),
    };
    plan.postVolume = p.volume;          // legacy assigned poly volume after construction
  }
  return plan;
}

// Build one connected voice from a plan. Returns { synth, filter }.
// openInsert: when the plan has no filter, add a transparent open lowpass so a
// velocity lock has a cutoff to modulate (pitched brightness). Drums pass false
// and keep using their plan filter (or none).
function buildFromPlan(plan, bus, openInsert = false) {
  let out = bus, filter = null;
  if (plan.filter) {
    filter = new Tone.Filter(plan.filter.freq, plan.filter.type).connect(bus);
    out = filter;
  } else if (openInsert) {
    filter = new Tone.Filter(BRIGHT_OPEN, 'lowpass').connect(bus);
    out = filter;
  }
  let synth;
  if (plan.ctor === 'PolySynth') {
    synth = new Tone.PolySynth(Tone.Synth).connect(out);
    synth.set(plan.options);
  } else {
    synth = new Tone[plan.ctor](plan.options).connect(out);
  }
  if (plan.postVolume !== undefined) synth.volume.value = plan.postVolume;
  return { synth, filter };
}

// Resolve + validate an instrument ref; bad data falls back (never crashes).
function resolveInstrument(id, instruments, fallbackId) {
  const inst = instruments?.[id];
  if (validateInstrument(inst)) return inst;
  return DEFAULT_INSTRUMENTS[fallbackId];
}

const PITCHED_DEFAULT = { bass: 'gb-bass', chords: 'gb-chords', melody: 'gb-lead' };

/**
 * createVoiceForType(type, bus, opts?)
 * opts: { instruments, kit, instrumentId } — defaults to the stock set.
 */
export function createVoiceForType(type, bus, opts = {}) {
  const instruments = opts.instruments ?? DEFAULT_INSTRUMENTS;
  if (type === 'drums') {
    const kit = opts.kit ?? DEFAULT_KIT;
    const byNote = {};
    const nodes = [];
    const fallbackByNote = Object.fromEntries(DEFAULT_KIT.slots.map(s => [s.note, s.instrument]));
    for (const slot of (kit.slots ?? [])) {
      const note = slotKey(slot.note);
      if (note === null) continue;
      const inst = resolveInstrument(slot.instrument, instruments, fallbackByNote[note] ?? 'gb-kick');
      if (!inst) continue;
      const plan = compileSynthPatch(inst);
      const v = buildFromPlan(plan, bus);
      // Carry the slot's tone filter so a velocity lock can move its cutoff per
      // hit (brightness, not just loudness). Unfiltered slots stay volume-only.
      byNote[note] = {
        synth: v.synth, trig: plan.trig,
        filter: v.filter,
        filterBase: plan.filter ? plan.filter.freq : 0,
        filterType: plan.filter ? plan.filter.type : null,
      };
      nodes.push(v.synth, v.filter);
    }
    return { byNote, dispose() { for (const n of nodes) { try { n?.dispose?.(); } catch (_) {} } } };
  }
  const fallback = PITCHED_DEFAULT[type];
  if (!fallback) return {};
  const inst = resolveInstrument(opts.instrumentId ?? fallback, instruments, fallback);
  const plan = compileSynthPatch(inst);
  const v = buildFromPlan(plan, bus, true);   // openInsert: a cutoff for velocity to modulate
  const dispose = () => { try { v.synth.dispose?.(); } catch (_) {} try { v.filter?.dispose?.(); } catch (_) {} };
  // Brightness modulates the character filter where one exists (chords @ 4200),
  // else the open insert (bass/melody @ BRIGHT_OPEN — transparent at rest).
  const tone = { toneFilter: v.filter, toneBase: plan.filter ? plan.filter.freq : BRIGHT_OPEN, toneType: plan.filter ? plan.filter.type : 'lowpass' };
  if (type === 'bass')   return { bass: v.synth, trig: plan.trig, ...tone, dispose };
  if (type === 'chords') return { chordSyn: v.synth, chordFilter: v.filter, trig: plan.trig, ...tone, dispose };
  return { lead: v.synth, trig: plan.trig, ...tone, dispose };
}

// Note duration → seconds. DATA-MODEL allows durSteps|'bar' on ANY note lane;
// 'bar' previously NaN-crashed bass/melody (killing the whole step scheduler —
// a shared song could freeze playback). Anything non-numeric falls back to 2
// steps: invariant 2 says bad data must never crash the engine.
function durSeconds(dur, sixteenth, barSeconds) {
  if (dur === 'bar') return barSeconds;
  return (typeof dur === 'number' && Number.isFinite(dur) && dur > 0 ? dur : 2) * sixteenth;
}

// Velocity p-lock: ev.vel multiplies the voice's base velocity, product clamped
// to 0..1. Unlocked events (ev.vel == null) pass the base through UNCHANGED —
// undefined base stays undefined (Tone defaults it), so legacy songs are
// byte-identical. Scalar math only: nothing here allocates in the hot path.
function lockVel(base, vel) {
  if (vel == null) return base;
  const v = (base ?? 1) * vel;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Velocity → brightness: a lock shifts a tone filter's cutoff by up to ~1.5
// octaves so accents pass MORE energy and ghosts less — a HIGHPASS moves DOWN on
// an accent (fuller), a LOWPASS moves UP (brighter). Scheduled at audio time t;
// every locked-or-not hit re-asserts a value (base when unlocked) so the filter
// never sticks. No-op when there's no filter. Scalar math, no allocs.
// Drums modulate their slot's own tone filter (hat/crash highpass). Pitched
// lanes modulate either their character lowpass (chords @ 4200) or an OPEN insert
// (bass/melody @ ~18k — transparent at rest, so unlocked notes are unchanged;
// ghosts darken, accents stay bright). Same-lane note overlaps share the filter
// (a soft tail can be nudged by the next note) — mild and musical, Elektron-ish.
const BRIGHT_OCT = 1.5;
function shiftCutoff(filter, base, type, vel, t) {
  if (!filter) return;
  let freq = base;
  if (vel != null) {
    let shift = (vel - 1) * BRIGHT_OCT;
    if (shift > BRIGHT_OCT) shift = BRIGHT_OCT; else if (shift < -BRIGHT_OCT) shift = -BRIGHT_OCT;
    const dir = type === 'highpass' ? -1 : 1;
    freq = base * Math.pow(2, dir * shift);
  }
  filter.frequency.setValueAtTime(freq, t);
}

/**
 * trigger(voice, ev, t, sixteenth, barSeconds)
 * Fires one scheduler event at audio time `t`.
 * Drum events route by GM note: ev.voice is canonical numeric after ingest
 * normalization, but slotKey() also accepts legacy names (engine edge stays
 * permissive — bad data never crashes; unknown slots are silently skipped).
 */
export function trigger(voice, ev, t, sixteenth, barSeconds) {
  if (ev.type === 'drums') {
    const note = slotKey(ev.voice);
    const slot = note === null ? undefined : voice.byNote?.[note];
    if (!slot) return;
    const { synth, trig } = slot;
    shiftCutoff(slot.filter, slot.filterBase, slot.filterType, ev.vel, t);
    if (trig.sig === 'noise') {
      synth.triggerAttackRelease(trig.dur ?? '16n', t, lockVel(trig.velocity, ev.vel));
    } else {
      const base = trig.note ?? 'C3';
      const pitch = ev.semi ? Tone.Frequency(base).transpose(ev.semi) : base;
      synth.triggerAttackRelease(pitch, trig.dur ?? '8n', t, lockVel(trig.velocity, ev.vel));
    }
  } else if (ev.type === 'bass') {
    shiftCutoff(voice.toneFilter, voice.toneBase, voice.toneType, ev.vel, t);
    voice.bass.triggerAttackRelease(ev.note, durSeconds(ev.dur, sixteenth, barSeconds), t, lockVel(voice.trig?.velocity ?? 0.85, ev.vel));
  } else if (ev.type === 'melody') {
    shiftCutoff(voice.toneFilter, voice.toneBase, voice.toneType, ev.vel, t);
    voice.lead.triggerAttackRelease(ev.note, durSeconds(ev.dur, sixteenth, barSeconds), t, lockVel(voice.trig?.velocity ?? 0.82, ev.vel));
  } else if (ev.type === 'chords') {
    shiftCutoff(voice.toneFilter, voice.toneBase, voice.toneType, ev.vel, t);
    // Arp hits ride slightly hotter than sustained voicings (legacy 0.34 vs 0.30).
    if (ev.mode === 'arp') voice.chordSyn.triggerAttackRelease(ev.note, sixteenth, t, lockVel(0.34, ev.vel));
    else voice.chordSyn.triggerAttackRelease(ev.notes, durSeconds(ev.dur, sixteenth, barSeconds), t, lockVel(voice.trig?.velocity ?? 0.3, ev.vel));
  }
}
