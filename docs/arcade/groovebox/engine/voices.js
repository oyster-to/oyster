import * as Tone from 'tone';

/**
 * createVoiceForType(type, bus)
 * Returns the voice object(s) for one lane, wired to `bus`.
 * - 'drums'  → { kick, snare, hat, tom, crash } (full kit)
 * - 'bass'   → { bass }
 * - 'chords' → { chordSyn }
 * - 'melody' → { lead }
 */
export function createVoiceForType(type, bus) {
  if (type === 'drums') {
    const kick  = new Tone.MembraneSynth({ volume: -5 }).connect(bus);
    const snare = new Tone.NoiseSynth({ volume: -11, envelope: { attack: 0.001, decay: 0.16, sustain: 0 } }).connect(bus);
    const hatFilter = new Tone.Filter(7000, 'highpass').connect(bus);
    const hat   = new Tone.NoiseSynth({ volume: -20, envelope: { attack: 0.001, decay: 0.03, sustain: 0 } }).connect(hatFilter);
    const tom   = new Tone.MembraneSynth({ volume: -6, pitchDecay: 0.06, octaves: 2 }).connect(bus);
    const crashFilter = new Tone.Filter(3500, 'highpass').connect(bus);
    const crash = new Tone.NoiseSynth({ volume: -12, envelope: { attack: 0.001, decay: 1.1, sustain: 0, release: 0.3 } }).connect(crashFilter);
    return { kick, snare, hat, tom, crash, hatFilter, crashFilter };
  }
  if (type === 'bass') {
    const bass = new Tone.MonoSynth({
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0.35, release: 0.18 },
      filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.4, baseFrequency: 120, octaves: 3 },
    }).connect(bus);
    bass.volume.value = -7;
    return { bass };
  }
  if (type === 'chords') {
    const chordFilter = new Tone.Filter(4200, 'lowpass').connect(bus);
    const chordSyn = new Tone.PolySynth(Tone.Synth).connect(chordFilter);
    chordSyn.set({ oscillator: { type: 'triangle' }, envelope: { attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.5 } });
    chordSyn.volume.value = -17;
    return { chordSyn, chordFilter };
  }
  if (type === 'melody') {
    const lead = new Tone.PolySynth(Tone.Synth).connect(bus);
    lead.set({ oscillator: { type: 'pulse', width: 0.3 }, envelope: { attack: 0.004, decay: 0.18, sustain: 0.2, release: 0.2 } });
    lead.volume.value = -11;
    return { lead };
  }
  return {};
}

/**
 * trigger(voice, ev, t, sixteenth, barSeconds)
 * Fires one scheduler event at audio time `t`.
 * voice — the voice object for ev.laneId (from voices[ev.laneId])
 * ev    — { laneId, type, ... }
 */
export function trigger(voice, ev, t, sixteenth, barSeconds) {
  if (ev.type === 'drums') {
    if (ev.voice === 'kick')  voice.kick.triggerAttackRelease('C1', '8n', t);
    if (ev.voice === 'snare') voice.snare.triggerAttackRelease('16n', t);
    if (ev.voice === 'hat')   voice.hat.triggerAttackRelease('32n', t, 0.6);
    if (ev.voice === 'crash') voice.crash.triggerAttackRelease('8n', t, 0.8);
    if (ev.voice === 'tom')   voice.tom.triggerAttackRelease(Tone.Frequency('A2').transpose(ev.semi), '8n', t);
  } else if (ev.type === 'bass') {
    voice.bass.triggerAttackRelease(ev.note, (ev.dur || 2) * sixteenth, t, 0.85);
  } else if (ev.type === 'melody') {
    voice.lead.triggerAttackRelease(ev.note, (ev.dur || 2) * sixteenth, t, 0.82);
  } else if (ev.type === 'chords') {
    if (ev.mode === 'arp') voice.chordSyn.triggerAttackRelease(ev.note, sixteenth, t, 0.34);
    else voice.chordSyn.triggerAttackRelease(ev.notes, ev.dur === 'bar' ? barSeconds : (ev.dur || 2) * sixteenth, t, 0.3);
  }
}

/**
 * createVoices(buses) — kept for compatibility; builds one voice per type.
 * buses: { drums, bass, chords, melody } — each a Tone input node.
 */
export function createVoices(buses) {
  const drums  = createVoiceForType('drums',  buses.drums);
  const bass   = createVoiceForType('bass',   buses.bass);
  const chords = createVoiceForType('chords', buses.chords);
  const melody = createVoiceForType('melody', buses.melody);
  // Flatten to the legacy named shape so any remaining callers still work.
  return { ...drums, ...bass, ...chords, ...melody };
}
