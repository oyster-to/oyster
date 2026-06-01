import * as Tone from 'tone';

// Build all synth voices, each connected to `dest` (a Tone node, e.g. the master limiter).
export function createVoices(dest) {
  const lead = new Tone.PolySynth(Tone.Synth).connect(dest);
  lead.set({ oscillator:{ type:'pulse', width:0.3 }, envelope:{ attack:0.004, decay:0.18, sustain:0.2, release:0.2 } });
  lead.volume.value = -11;
  const bass = new Tone.MonoSynth({ oscillator:{ type:'triangle' },
    envelope:{ attack:0.005, decay:0.18, sustain:0.35, release:0.18 },
    filterEnvelope:{ attack:0.005, decay:0.12, sustain:0.4, baseFrequency:120, octaves:3 } }).connect(dest);
  bass.volume.value = -7;
  const chordSyn = new Tone.PolySynth(Tone.Synth).connect(new Tone.Filter(4200,'lowpass').connect(dest));
  chordSyn.set({ oscillator:{ type:'triangle' }, envelope:{ attack:0.05, decay:0.3, sustain:0.6, release:0.5 } });
  chordSyn.volume.value = -17;
  const kick  = new Tone.MembraneSynth({ volume:-2 }).connect(dest);
  const snare = new Tone.NoiseSynth({ volume:-11, envelope:{ attack:0.001, decay:0.16, sustain:0 } }).connect(dest);
  const hat   = new Tone.NoiseSynth({ volume:-20, envelope:{ attack:0.001, decay:0.03, sustain:0 } })
                  .connect(new Tone.Filter(7000,'highpass').connect(dest));
  const tom   = new Tone.MembraneSynth({ volume:-6, pitchDecay:0.06, octaves:2 }).connect(dest);
  const crash = new Tone.NoiseSynth({ volume:-12, envelope:{ attack:0.001, decay:1.1, sustain:0, release:0.3 } })
                  .connect(new Tone.Filter(3500,'highpass').connect(dest));
  return { lead, bass, chordSyn, kick, snare, hat, tom, crash };
}

// Fire one scheduler event at audio time `t`. `sixteenth` = seconds per 16th step; `barSeconds` = seconds per bar.
export function trigger(v, ev, t, sixteenth, barSeconds) {
  if (ev.lane === 'drums') {
    if (ev.voice === 'kick')  v.kick.triggerAttackRelease('C1', '8n', t);
    if (ev.voice === 'snare') v.snare.triggerAttackRelease('16n', t);
    if (ev.voice === 'hat')   v.hat.triggerAttackRelease('32n', t, 0.6);
    if (ev.voice === 'crash') v.crash.triggerAttackRelease('8n', t, 0.8);
    if (ev.voice === 'tom')   v.tom.triggerAttackRelease(Tone.Frequency('A2').transpose(ev.semi), '8n', t);
  } else if (ev.lane === 'bass') {
    v.bass.triggerAttackRelease(ev.note, (ev.dur || 2) * sixteenth, t, 0.85);
  } else if (ev.lane === 'melody') {
    v.lead.triggerAttackRelease(ev.note, (ev.dur || 2) * sixteenth, t, 0.82);
  } else if (ev.lane === 'chords') {
    if (ev.mode === 'arp') v.chordSyn.triggerAttackRelease(ev.note, sixteenth, t, 0.34);
    else v.chordSyn.triggerAttackRelease(ev.notes, ev.dur === 'bar' ? barSeconds : ev.dur * sixteenth, t, 0.3);
  }
}
