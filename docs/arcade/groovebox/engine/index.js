import * as Tone from 'tone';
import { stepsPerBar } from './meter.js';
import { eventsForStep } from './scheduler.js';
import { createVoices, trigger } from './voices.js';
import { setLane as _setLane, toggleMute as _toggleMute, soloExclusive as _soloExclusive, captureScene as _captureScene, toggleDrumMute as _toggleDrumMute, toggleDrumSolo as _toggleDrumSolo } from './lanes.js';
import { sectionAt } from './arrangement.js';

export function createEngine() {
  let song = null, voices = null, master = null, fx = null, step = 0, started = false, repeatId = null, tempo = 120, playing = false, onStepCb = null, toneType = 'pulse', pendingFill = null, activeFill = null, queuedFill = null;
  let mode = 'live', songBar = 0;
  const PHRASE = 4;
  let masterComp = null, masterRev = null;
  let scopeMaster = null, scopeLane = {};
  function ensure() {
    if (started) return;
    const out = new Tone.Limiter(-1).toDestination();
    masterComp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.01, release: 0.2 }).connect(out);
    masterRev  = new Tone.Reverb({ decay: 2.2, wet: 0 }).connect(masterComp);
    const masterIn = masterRev;
    const makeFX = dest => {
      const vol = new Tone.Gain(1).connect(dest);
      const pan = new Tone.Panner(0).connect(vol);
      const dl = new Tone.FeedbackDelay({ delayTime:'8n', feedback:0.28, wet:0 }).connect(pan);
      const rev = new Tone.Reverb({ decay:2.0, wet:0 }).connect(dl);
      const comp = new Tone.Compressor({ threshold:0, ratio:1, attack:0.01, release:0.2 }).connect(rev);
      const cr = new Tone.BitCrusher(4).connect(comp);  cr.wet.value = 0;
      const dr = new Tone.Distortion({ distortion:0.4, oversample:'4x' }).connect(cr); dr.wet.value = 0;
      const ft = new Tone.Filter({ type:'lowpass', frequency:14000, Q:0.7 }).connect(dr);
      return { filter:ft, drive:dr, crush:cr, comp, reverb:rev, delay:dl, panner:pan, vol, input:ft, _cutType:'lowpass' };
    };
    fx = { drums:makeFX(masterIn), bass:makeFX(masterIn), chords:makeFX(masterIn), melody:makeFX(masterIn) };
    voices = createVoices({ drums:fx.drums.input, bass:fx.bass.input, chords:fx.chords.input, melody:fx.melody.input });
    voices.lead.set({ oscillator:{ type: toneType, width: 0.3 } });
    // Waveform analysers (sinks — don't alter the audio chain).
    scopeMaster = new Tone.Waveform(1024);
    masterComp.connect(scopeMaster);
    for (const lane of ['drums','bass','chords','melody']) {
      scopeLane[lane] = new Tone.Waveform(1024);
      fx[lane].vol.connect(scopeLane[lane]);
    }
    started = true;
  }
  return {
    load(s) { song = s; tempo = (typeof s.bpm === 'number' && isFinite(s.bpm)) ? s.bpm : tempo; },
    async play() {
      if (!song) throw new Error('no song loaded');
      if (playing) return;                                   // ignore double-play (don't stack callbacks)
      await Tone.start(); ensure();
      step = 0; songBar = 0;
      Tone.Transport.bpm.value = tempo;
      if (repeatId !== null) Tone.Transport.clear(repeatId);
      repeatId = Tone.Transport.scheduleRepeat((t) => {
        const sixteenth = Tone.Time('16n').toSeconds();
        const barSeconds = stepsPerBar(song.meter) * sixteenth;
        const spb = stepsPerBar(song.meter);
        if (step % spb === 0) {
          const prevFill = activeFill;
          if (mode === 'song' && song.arrangement && song.arrangement.length) {
            const at = sectionAt(song.arrangement, songBar);
            const L = at.section.lanes;
            song.lanes.drums.selection  = L.drums;
            song.lanes.bass.selection   = L.bass;
            song.lanes.chords.selection = L.chords;
            song.lanes.melody.selection = L.melody;
            activeFill = at.isLastBar ? (at.section.fill || null) : null;
            pendingFill = null;
            songBar++;
          } else {
            const barIdx = step / spb;
            if (queuedFill && (barIdx % PHRASE) === PHRASE - 1) { activeFill = queuedFill; queuedFill = null; }
            else { activeFill = pendingFill; }
            pendingFill = null;
          }
          if (prevFill && !activeFill && voices) voices.crash.triggerAttackRelease('8n', t, 0.9);
        }
        const fillPat = activeFill ? (song.fills?.[activeFill] ?? null) : null;
        for (const ev of eventsForStep(song, step, fillPat)) trigger(voices, ev, t, sixteenth, barSeconds);
        if (onStepCb) { const s = step; const sb = songBar; const qf = queuedFill;
          Tone.Draw.schedule(() => {
            const bar = Math.floor(s/spb);
            const barsToFill = qf ? ((PHRASE - 1 - (bar % PHRASE)) + PHRASE) % PHRASE : -1;
            onStepCb({
              absStep: s,
              bar,
              stepInBar: s % spb,
              fill: activeFill,
              mode,
              songIndex: (mode === 'song' && song.arrangement && song.arrangement.length)
                ? sectionAt(song.arrangement, Math.max(0, sb - 1)).index
                : -1,
              queued: qf,
              barsToFill,
            });
          }, t); }
        step++;
      }, '16n');
      Tone.Transport.start();
      playing = true;
    },
    stop() {
      Tone.Transport.stop();
      if (repeatId !== null) { Tone.Transport.clear(repeatId); repeatId = null; }
      step = 0; playing = false; pendingFill = null; activeFill = null; queuedFill = null;
    },
    setTempo(bpm) { if (typeof bpm === 'number' && isFinite(bpm)) { tempo = bpm; Tone.Transport.bpm.value = bpm; } },
    onStep(cb) { onStepCb = cb; },
    getSong() { return song; },
    setLane(lane, selection) { if (song) _setLane(song, lane, selection); },
    toggleMute(lane) { return song ? _toggleMute(song, lane) : false; },
    toggleSolo(lane) { return song ? _soloExclusive(song, lane) : false; },
    triggerFill(name) { pendingFill = name; },
    queueFill(name) { queuedFill = (queuedFill === name) ? null : name; return queuedFill; },
    clearQueue() { queuedFill = null; },
    toggleDrumMute(voice) { return song ? _toggleDrumMute(song, voice) : false; },
    toggleDrumSolo(voice) { return song ? _toggleDrumSolo(song, voice) : false; },
    clearFill() { pendingFill = null; activeFill = null; },
    setMode(m) { mode = m; songBar = 0; },
    getMode() { return mode; },
    captureScene() { if (song) { song.arrangement = song.arrangement || []; song.arrangement.push(_captureScene(song)); } return song ? song.arrangement.length : 0; },
    clearArrangement() { if (song) song.arrangement = []; },
    setTone(type) { toneType = type; if (voices) voices.lead.set({ oscillator:{ type, width: 0.3 } }); },
    getScope(source) {
      if (!started) return null;
      if (source === 'master') return scopeMaster ? scopeMaster.getValue() : null;
      return scopeLane[source] ? scopeLane[source].getValue() : null;
    },
    setLaneFX(lane, param, v01) {
      if (!fx || !fx[lane]) return;
      const c = fx[lane];
      if (param === 'cut') {                                   // bipolar: center=open, left=lowpass(darker), right=highpass(thinner)
        if (v01 < 0.5) { if (c._cutType !== 'lowpass')  { c.filter.type = 'lowpass';  c._cutType = 'lowpass';  } const a = (0.5 - v01) / 0.5; c.filter.frequency.rampTo(20000 * Math.pow(200/20000, a), 0.08); }
        else           { if (c._cutType !== 'highpass') { c.filter.type = 'highpass'; c._cutType = 'highpass'; } const a = (v01 - 0.5) / 0.5; c.filter.frequency.rampTo(20 * Math.pow(8000/20, a), 0.08); }
      }
      else if (param === 'drive') c.drive.wet.rampTo(v01 * 0.85, 0.08);
      else if (param === 'crush') c.crush.wet.rampTo(v01, 0.08);
      else if (param === 'delay') c.delay.wet.rampTo(v01 * 0.5, 0.08);
      else if (param === 'vol')    c.vol.gain.rampTo(v01, 0.08);
      else if (param === 'pan')    c.panner.pan.rampTo((v01 - 0.5) * 2, 0.08);
      else if (param === 'reverb') c.reverb.wet.rampTo(v01 * 0.6, 0.08);
      else if (param === 'comp')   { c.comp.threshold.value = -30 * v01; c.comp.ratio.value = 1 + 7 * v01; }
    },
    setMasterFX(param, v01) {
      if (param === 'reverb' && masterRev) masterRev.wet.rampTo(v01 * 0.6, 0.05);
      else if (param === 'comp' && masterComp) { masterComp.threshold.value = -30 * v01; masterComp.ratio.value = 1 + 7 * v01; }
    },
  };
}
