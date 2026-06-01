import * as Tone from 'tone';
import { stepsPerBar } from './meter.js';
import { eventsForStep } from './scheduler.js';
import { createVoices, trigger } from './voices.js';
import { setLane as _setLane, toggleMute as _toggleMute } from './lanes.js';

export function createEngine() {
  let song = null, voices = null, master = null, fx = null, step = 0, started = false, repeatId = null, tempo = 120, playing = false, onStepCb = null, toneType = 'pulse';
  function ensure() {
    if (started) return;
    master = new Tone.Limiter(-1).toDestination();
    const makeFX = dest => {
      const dl = new Tone.FeedbackDelay({ delayTime:'8n', feedback:0.28, wet:0 }).connect(dest);
      const dr = new Tone.Distortion(0.4).connect(dl); dr.wet.value = 0;
      const ft = new Tone.Filter({ type:'lowpass', frequency:14000, Q:1 }).connect(dr);
      return { filter:ft, drive:dr, delay:dl, input:ft };
    };
    fx = { drums:makeFX(master), bass:makeFX(master), chords:makeFX(master), melody:makeFX(master) };
    voices = createVoices({ drums:fx.drums.input, bass:fx.bass.input, chords:fx.chords.input, melody:fx.melody.input });
    voices.lead.set({ oscillator:{ type: toneType, width: 0.3 } });
    started = true;
  }
  return {
    load(s) { song = s; tempo = s.bpm; },
    async play() {
      if (!song) throw new Error('no song loaded');
      if (playing) return;                                   // ignore double-play (don't stack callbacks)
      await Tone.start(); ensure();
      step = 0;
      Tone.Transport.bpm.value = tempo;
      if (repeatId !== null) Tone.Transport.clear(repeatId);
      repeatId = Tone.Transport.scheduleRepeat((t) => {
        const sixteenth = Tone.Time('16n').toSeconds();
        const barSeconds = stepsPerBar(song.meter) * sixteenth;
        for (const ev of eventsForStep(song, step)) trigger(voices, ev, t, sixteenth, barSeconds);
        if (onStepCb) { const spb = stepsPerBar(song.meter); const s = step;
          Tone.Draw.schedule(() => onStepCb({ absStep: s, bar: Math.floor(s/spb), stepInBar: s % spb }), t); }
        step++;
      }, '16n');
      Tone.Transport.start();
      playing = true;
    },
    stop() {
      Tone.Transport.stop();
      if (repeatId !== null) { Tone.Transport.clear(repeatId); repeatId = null; }
      step = 0; playing = false;
    },
    setTempo(bpm) { tempo = bpm; Tone.Transport.bpm.value = bpm; },
    onStep(cb) { onStepCb = cb; },
    getSong() { return song; },
    setLane(lane, selection) { if (song) _setLane(song, lane, selection); },
    toggleMute(lane) { return song ? _toggleMute(song, lane) : false; },
    setTone(type) { toneType = type; if (voices) voices.lead.set({ oscillator:{ type, width: 0.3 } }); },
    setLaneFX(lane, param, v01) {
      if (!fx || !fx[lane]) return;
      const c = fx[lane];
      if (param === 'cut') {                                   // bipolar: center=open, left=lowpass(darker), right=highpass(thinner)
        if (v01 < 0.5) { c.filter.type = 'lowpass';  const a = (0.5 - v01) / 0.5; c.filter.frequency.rampTo(20000 * Math.pow(200/20000, a), 0.05); }
        else           { c.filter.type = 'highpass'; const a = (v01 - 0.5) / 0.5; c.filter.frequency.rampTo(20 * Math.pow(8000/20, a), 0.05); }
      }
      else if (param === 'drive') c.drive.wet.rampTo(v01 * 0.85, 0.05);
      else if (param === 'delay') c.delay.wet.rampTo(v01 * 0.5, 0.05);
    },
  };
}
