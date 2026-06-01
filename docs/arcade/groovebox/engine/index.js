import * as Tone from 'tone';
import { stepsPerBar } from './meter.js';
import { eventsForStep } from './scheduler.js';
import { createVoiceForType, trigger } from './voices.js';
import { normalizeLanes, cachePoolsByType, laneByType, setLane as _setLane, toggleMute as _toggleMute, soloExclusive as _soloExclusive, captureScene as _captureScene, toggleDrumMute as _toggleDrumMute, toggleDrumSolo as _toggleDrumSolo, addLane as _addLane, duplicateLane as _duplicateLane, removeLane as _removeLane, renameLane as _renameLane, moveLane as _moveLane } from './lanes.js';
import { sectionAt } from './arrangement.js';

export function createEngine() {
  let song = null, step = 0, started = false, repeatId = null, tempo = 120, playing = false, onStepCb = null, pendingFill = null, activeFill = null, fillQueue = [];
  let mode = 'live', songBar = 0;
  let masterComp = null, masterRev = null, masterVol = null, masterPan = null, masterWidth = null, masterEQ = null;
  let meterL = null, meterR = null;
  let scopeMaster = null, scopeLane = {};
  // Per-lane keyed maps (by lane.id)
  let voices = {}, fx = {}, meters = {};
  // Stored after ensure() so buildLane can be called post-graph-init
  let _makeFX = null, _masterIn = null, _laneReverb = null;

  function buildLane(lane) {
    fx[lane.id]     = _makeFX(_masterIn);
    voices[lane.id] = createVoiceForType(lane.type, fx[lane.id].input);
    // Apply saved tone to melody lanes
    if (lane.type === 'melody' && lane.tone) {
      voices[lane.id].lead?.set({ oscillator: { type: lane.tone, width: 0.3 } });
    }
    // Per-lane scope analyser
    scopeLane[lane.id] = new Tone.Waveform(1024);
    fx[lane.id].vol.connect(scopeLane[lane.id]);
    // Per-lane level meter
    meters[lane.id] = new Tone.Meter({ normalRange: false });
    fx[lane.id].vol.connect(meters[lane.id]);
  }

  function buildLaneGraph(lanes) {
    for (const lane of lanes) buildLane(lane);
  }

  function disposeLane(id) {
    // Dispose voice node(s)
    const v = voices[id];
    if (v) {
      for (const node of Object.values(v)) {
        try { node.dispose?.(); } catch (_) {}
      }
      delete voices[id];
    }
    // Dispose FX chain
    const f = fx[id];
    if (f) {
      for (const node of Object.values(f)) {
        try { if (node && typeof node.dispose === 'function') node.dispose(); } catch (_) {}
      }
      delete fx[id];
    }
    // Dispose meter + scope
    try { meters[id]?.dispose?.(); } catch (_) {}
    delete meters[id];
    try { scopeLane[id]?.dispose?.(); } catch (_) {}
    delete scopeLane[id];
  }

  function ensure() {
    if (started) return;
    const out = new Tone.Limiter(-1).toDestination();
    // Headroom trim BEFORE the limiter: the summed voices run hot, so without
    // this the limiter slams every beat (audible popping/crackle). ~-6dB leaves
    // room so the limiter only catches occasional true peaks.
    const masterTrim = new Tone.Gain(0.5).connect(out);
    masterVol  = new Tone.Gain(1).connect(masterTrim);
    masterPan  = new Tone.Panner(0).connect(masterVol);
    masterComp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.01, release: 0.2 }).connect(masterPan);
    masterRev  = new Tone.Reverb({ decay: 2.2, wet: 0 }).connect(masterComp);
    masterWidth = new Tone.StereoWidener(0.5).connect(masterRev);
    masterEQ   = new Tone.EQ3({ low: 0, mid: 0, high: 0 }).connect(masterWidth);
    const masterIn = masterEQ;
    // Shared reverb bus — one convolver for all lanes (per-lane send gain controls amount).
    _laneReverb = new Tone.Reverb({ decay: 2.4, wet: 1 }).connect(masterIn);
    // Stereo output meters — tapped post-volume (silent sinks, don't alter audio chain).
    const split = new Tone.Split();
    masterVol.connect(split);
    meterL = new Tone.Meter({ normalRange: false });
    meterR = new Tone.Meter({ normalRange: false });
    split.connect(meterL, 0, 0);
    split.connect(meterR, 1, 0);
    _makeFX = dest => {
      const vol = new Tone.Gain(1).connect(dest);
      const pan = new Tone.Panner(0).connect(vol);
      const dl = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.28, wet: 0 }).connect(pan);
      const comp = new Tone.Compressor({ threshold: 0, ratio: 1, attack: 0.01, release: 0.2 }).connect(dl);
      const auto = new Tone.AutoFilter({ frequency: '8n', depth: 0.7, baseFrequency: 200, octaves: 4, wet: 0 }).start(); auto.connect(comp);
      const chorus = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0 }).start(); chorus.connect(auto);
      const cr = new Tone.BitCrusher(4).connect(chorus); cr.wet.value = 0;
      const dr = new Tone.Distortion({ distortion: 0.4, oversample: 'none' }).connect(cr); dr.wet.value = 0;
      const ft = new Tone.Filter({ type: 'lowpass', frequency: 14000, Q: 0.7 }).connect(dr);
      // Post-fader send to shared reverb bus; gain=0 → dry by default.
      const reverbSend = new Tone.Gain(0); vol.connect(reverbSend); reverbSend.connect(_laneReverb);
      return { filter: ft, drive: dr, crush: cr, chorus, auto, comp, reverbSend, delay: dl, panner: pan, vol, input: ft, _cutType: 'lowpass' };
    };
    _masterIn = masterIn;
    // Waveform analyser for master (sink — doesn't alter audio chain).
    scopeMaster = new Tone.Waveform(1024);
    masterComp.connect(scopeMaster);
    // Build per-lane graph
    buildLaneGraph(song.lanes);
    started = true;
  }

  return {
    load(s) {
      s.lanes = normalizeLanes(s.lanes, s);
      song = s;
      tempo = (typeof s.bpm === 'number' && isFinite(s.bpm)) ? s.bpm : tempo;
    },
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
            // Authored arrangement sections use type-keyed lane names; map by type → lane id
            const L = at.section.lanes;
            for (const [typeName, selection] of Object.entries(L)) {
              const lane = laneByType(song.lanes, typeName);
              if (lane) lane.selection = selection;
            }
            activeFill = at.isLastBar ? (at.section.fill || null) : null;
            pendingFill = null;
            songBar++;
          } else {
            activeFill = fillQueue.length ? fillQueue.shift() : pendingFill;
            pendingFill = null;
          }
          if (prevFill && !activeFill) {
            const drumsVoice = voices[laneByType(song.lanes, 'drums')?.id];
            if (drumsVoice) drumsVoice.crash.triggerAttackRelease('8n', t, 0.9);
          }
        }
        const fillPat = activeFill ? (song.fills?.[activeFill] ?? null) : null;
        for (const ev of eventsForStep(song, song.lanes, step, fillPat)) {
          const v = voices[ev.laneId];
          if (v) trigger(v, ev, t, sixteenth, barSeconds);
        }
        if (onStepCb) {
          const s = step; const sb = songBar; const qSnap = fillQueue.slice();
          Tone.Draw.schedule(() => {
            const bar = Math.floor(s / spb);
            onStepCb({
              absStep: s,
              bar,
              stepInBar: s % spb,
              fill: activeFill,
              mode,
              songIndex: (mode === 'song' && song.arrangement && song.arrangement.length)
                ? sectionAt(song.arrangement, Math.max(0, sb - 1)).index
                : -1,
              queue: qSnap,
            });
          }, t);
        }
        step++;
      }, '16n');
      Tone.Transport.start();
      playing = true;
    },
    stop() {
      Tone.Transport.stop();
      if (repeatId !== null) { Tone.Transport.clear(repeatId); repeatId = null; }
      step = 0; playing = false; pendingFill = null; activeFill = null; fillQueue = [];
    },
    setTempo(bpm) { if (typeof bpm === 'number' && isFinite(bpm)) { tempo = bpm; Tone.Transport.bpm.value = bpm; } },
    onStep(cb) { onStepCb = cb; },
    getSong() { return song; },
    getLanes() { return song ? song.lanes : []; },
    // Lane ops by id
    setLane(id, selection)  { if (song) _setLane(song.lanes, id, selection); },
    toggleMute(id)          { return song ? _toggleMute(song.lanes, id) : false; },
    toggleSolo(id)          { return song ? _soloExclusive(song.lanes, id) : false; },
    triggerFill(name)       { pendingFill = name; },
    queueFill(name)         { fillQueue.push(name); return fillQueue.length; },
    unqueueAt(i)            { if (i >= 0 && i < fillQueue.length) fillQueue.splice(i, 1); return fillQueue.slice(); },
    clearQueue()            { fillQueue = []; },
    toggleDrumMute(voice) {
      if (!song) return false;
      const dl = laneByType(song.lanes, 'drums');
      return dl ? _toggleDrumMute(dl, voice) : false;
    },
    toggleDrumSolo(voice) {
      if (!song) return false;
      const dl = laneByType(song.lanes, 'drums');
      return dl ? _toggleDrumSolo(dl, voice) : false;
    },
    clearFill()  { pendingFill = null; activeFill = null; },
    setMode(m)   { mode = m; songBar = 0; },
    getMode()    { return mode; },
    captureScene() {
      if (song) {
        song.arrangement = song.arrangement || [];
        // captureScene returns { bars, lanes: { [laneId]: selection }, fill }
        // For song-mode compatibility, we also need the type-keyed shape the arrangement expects.
        // Re-encode back to type-keyed (for the 4 default lanes which have id===type).
        const snapshot = _captureScene(song.lanes);
        // Re-key lanes by type for authored arrangement back-compat
        const typedLanes = {};
        for (const lane of song.lanes) typedLanes[lane.type] = snapshot.lanes[lane.id];
        song.arrangement.push({ ...snapshot, lanes: typedLanes });
      }
      return song ? song.arrangement.length : 0;
    },
    clearArrangement() { if (song) song.arrangement = []; },
    // setTone by lane id (melody lanes)
    setTone(id, type) {
      // Back-compat: if called with one arg (old API), treat it as the melody lane
      if (type === undefined) { type = id; id = laneByType(song?.lanes ?? [], 'melody')?.id; }
      if (!id || !song) return;
      const lane = song.lanes.find(l => l.id === id);
      if (lane) lane.tone = type;
      const v = voices[id];
      if (v?.lead) v.lead.set({ oscillator: { type, width: 0.3 } });
    },
    getLevel(id) {
      if (!started || !meters[id]) return 0;
      let db = meters[id].getValue();
      if (Array.isArray(db)) db = db[0];
      if (!isFinite(db)) return 0;
      return Math.max(0, Math.min(1, (db + 60) / 60));
    },
    getScope(source) {
      if (!started) return null;
      if (source === 'master') return scopeMaster ? scopeMaster.getValue() : null;
      return scopeLane[source] ? scopeLane[source].getValue() : null;
    },
    setLaneFX(id, param, v01) {
      if (!fx || !fx[id]) return;
      const c = fx[id];
      if (param === 'cut') {                                   // bipolar: center=open, left=lowpass(darker), right=highpass(thinner)
        if (v01 < 0.5) { if (c._cutType !== 'lowpass')  { c.filter.type = 'lowpass';  c._cutType = 'lowpass';  } const a = (0.5 - v01) / 0.5; c.filter.frequency.rampTo(20000 * Math.pow(200 / 20000, a), 0.08); }
        else           { if (c._cutType !== 'highpass') { c.filter.type = 'highpass'; c._cutType = 'highpass'; } const a = (v01 - 0.5) / 0.5; c.filter.frequency.rampTo(20 * Math.pow(8000 / 20, a), 0.08); }
      }
      else if (param === 'drive')  { c.drive.wet.rampTo(v01 * 0.85, 0.08); c.drive.oversample = v01 > 0 ? '2x' : 'none'; }
      else if (param === 'crush')  c.crush.wet.rampTo(v01, 0.08);
      else if (param === 'delay')  c.delay.wet.rampTo(v01 * 0.5, 0.08);
      else if (param === 'vol')    c.vol.gain.rampTo(v01, 0.08);
      else if (param === 'pan')    c.panner.pan.rampTo((v01 - 0.5) * 2, 0.08);
      else if (param === 'reverb') c.reverbSend.gain.rampTo(v01 * 0.6, 0.05);
      else if (param === 'comp')   { c.comp.threshold.value = -30 * v01; c.comp.ratio.value = 1 + 7 * v01; }
      else if (param === 'res')    c.filter.Q.rampTo(0.7 + v01 * 14, 0.05);
      else if (param === 'fdbk')   c.delay.feedback.rampTo(v01 * 0.9, 0.05);
      else if (param === 'cho')    c.chorus.wet.rampTo(v01, 0.05);
      else if (param === 'wob')    c.auto.wet.rampTo(v01, 0.05);
    },
    setMasterFX(param, v01) {
      if      (param === 'reverb' && masterRev)   masterRev.wet.rampTo(v01 * 0.6, 0.05);
      else if (param === 'comp'   && masterComp)  { masterComp.threshold.value = -30 * v01; masterComp.ratio.value = 1 + 7 * v01; }
      else if (param === 'vol'    && masterVol)   masterVol.gain.rampTo(v01, 0.05);
      else if (param === 'bal'    && masterPan)   masterPan.pan.rampTo((v01 - 0.5) * 2, 0.05);
      else if (param === 'width'  && masterWidth) masterWidth.width.rampTo(v01, 0.05);
      else if (param === 'lo'     && masterEQ)    masterEQ.low.value  = (v01 - 0.5) * 24;
      else if (param === 'hi'     && masterEQ)    masterEQ.high.value = (v01 - 0.5) * 24;
    },
    getMasterLevel() {
      if (!started || !meterL || !meterR) return [0, 0];
      function toLevel(meter) {
        let db = meter.getValue();
        if (Array.isArray(db)) db = db[0];
        if (!isFinite(db)) return 0;
        return Math.max(0, Math.min(1, (db + 60) / 60));
      }
      return [toLevel(meterL), toLevel(meterR)];
    },
    // ─── Stage 2: lane mutation APIs ─────────────────────────────────────────
    addLane(type) {
      if (!song) return null;
      const lane = _addLane(song, type);
      if (started) buildLane(lane);
      return lane;
    },
    duplicateLane(id) {
      if (!song) return null;
      const lane = _duplicateLane(song, id);
      if (lane && started) buildLane(lane);
      return lane;
    },
    removeLane(id) {
      if (!song) return null;
      const removed = _removeLane(song, id);
      if (removed && started) disposeLane(removed);
      return removed;
    },
    renameLane(id, name) {
      if (song) _renameLane(song, id, name);
    },
    moveLane(id, toIndex) {
      if (song) _moveLane(song, id, toIndex);
    },
    setTranspose(semis) { if (song) song.transpose = (semis | 0); },
    getTranspose() { return song ? (song.transpose || 0) : 0; },
  };
}
