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
function buildFromPlan(plan, bus) {
  let out = bus, filter = null;
  if (plan.filter) {
    filter = new Tone.Filter(plan.filter.freq, plan.filter.type).connect(bus);
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
      byNote[note] = { synth: v.synth, trig: plan.trig };
      nodes.push(v.synth, v.filter);
    }
    return { byNote, dispose() { for (const n of nodes) { try { n?.dispose?.(); } catch (_) {} } } };
  }
  const fallback = PITCHED_DEFAULT[type];
  if (!fallback) return {};
  const inst = resolveInstrument(opts.instrumentId ?? fallback, instruments, fallback);
  const plan = compileSynthPatch(inst);
  const v = buildFromPlan(plan, bus);
  const dispose = () => { try { v.synth.dispose?.(); } catch (_) {} try { v.filter?.dispose?.(); } catch (_) {} };
  if (type === 'bass')   return { bass: v.synth, trig: plan.trig, dispose };
  if (type === 'chords') return { chordSyn: v.synth, chordFilter: v.filter, trig: plan.trig, dispose };
  return { lead: v.synth, trig: plan.trig, dispose };
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
    if (trig.sig === 'noise') {
      synth.triggerAttackRelease(trig.dur ?? '16n', t, lockVel(trig.velocity, ev.vel));
    } else {
      const base = trig.note ?? 'C3';
      const pitch = ev.semi ? Tone.Frequency(base).transpose(ev.semi) : base;
      synth.triggerAttackRelease(pitch, trig.dur ?? '8n', t, lockVel(trig.velocity, ev.vel));
    }
  } else if (ev.type === 'bass') {
    voice.bass.triggerAttackRelease(ev.note, durSeconds(ev.dur, sixteenth, barSeconds), t, lockVel(voice.trig?.velocity ?? 0.85, ev.vel));
  } else if (ev.type === 'melody') {
    voice.lead.triggerAttackRelease(ev.note, durSeconds(ev.dur, sixteenth, barSeconds), t, lockVel(voice.trig?.velocity ?? 0.82, ev.vel));
  } else if (ev.type === 'chords') {
    // Arp hits ride slightly hotter than sustained voicings (legacy 0.34 vs 0.30).
    if (ev.mode === 'arp') voice.chordSyn.triggerAttackRelease(ev.note, sixteenth, t, lockVel(0.34, ev.vel));
    else voice.chordSyn.triggerAttackRelease(ev.notes, durSeconds(ev.dur, sixteenth, barSeconds), t, lockVel(voice.trig?.velocity ?? 0.3, ev.vel));
  }
}
