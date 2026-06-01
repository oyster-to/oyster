import * as Tone from 'tone';
import { stepsPerBar } from './meter.js';
import { eventsForStep } from './scheduler.js';
import { createVoices, trigger } from './voices.js';

export function createEngine() {
  let song = null, voices = null, master = null, step = 0, started = false;
  function ensure() {
    if (started) return;
    master = new Tone.Limiter(-1).toDestination();
    voices = createVoices(master);
    started = true;
  }
  return {
    load(s) { song = s; },
    async play() {
      if (!song) throw new Error('no song loaded');
      await Tone.start(); ensure();
      step = 0;
      Tone.Transport.bpm.value = song.bpm;
      Tone.Transport.scheduleRepeat((t) => {
        const sixteenth = Tone.Time('16n').toSeconds();
        const barSeconds = stepsPerBar(song.meter) * sixteenth;
        for (const ev of eventsForStep(song, step)) trigger(voices, ev, t, sixteenth, barSeconds);
        step++;
      }, '16n');
      Tone.Transport.start();
    },
    stop() { Tone.Transport.stop(); Tone.Transport.cancel(); },
    setTempo(bpm) { if (song) song.bpm = bpm; Tone.Transport.bpm.value = bpm; },
  };
}
