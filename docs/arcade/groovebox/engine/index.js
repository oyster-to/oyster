import * as Tone from 'tone';
import { stepsPerBar } from './meter.js';
import { eventsForStep, swingOffset } from './scheduler.js';
import { createVoiceForType, trigger } from './voices.js';
import { normalizeLanes, cachePoolsByType, laneByType, setLane as _setLane, toggleMute as _toggleMute, soloExclusive as _soloExclusive, captureScene as _captureScene, toggleDrumMute as _toggleDrumMute, toggleDrumSolo as _toggleDrumSolo, addLane as _addLane, duplicateLane as _duplicateLane, removeLane as _removeLane, renameLane as _renameLane, moveLane as _moveLane } from './lanes.js';
import { sectionAt } from './arrangement.js';

export function createEngine() {
  let song = null, step = 0, started = false, repeatId = null, tempo = 120, playing = false, onStepCb = null, pendingFill = null, activeFill = null, fillQueue = [];
  let mode = 'live', songBar = 0;
  let swing = 0;
  let keyQuantize = false, pendingTranspose = null;
  let masterComp = null, masterRev = null, masterVol = null, masterPan = null, masterWidth = null, masterEQ = null;
  let meterL = null, meterR = null;
  let scopeMaster = null, scopeLane = {};
  // Per-lane keyed maps (by lane.id)
  let voices = {}, fx = {}, meters = {};
  // Tracks which lazy FX nodes have been inserted into the chain per lane.
  // Shape: { [laneId]: { cho: bool, wob: bool, crush: bool } }
  let _fxInserted = {};
  // Stored after ensure() so buildLane can be called post-graph-init
  let _makeFX = null, _masterIn = null, _laneReverb = null;

  function buildLane(lane) {
    fx[lane.id]     = _makeFX(_masterIn);
    voices[lane.id] = createVoiceForType(lane.type, fx[lane.id].input);
    // Apply saved tone to melody lanes
    if (lane.type === 'melody' && lane.tone) {
      voices[lane.id].lead?.set({ oscillator: { type: lane.tone, width: 0.3 } });
    }
    // Per-lane scope analyser — lazy: created on first getScope(id) call.
    // scopeLane[lane.id] intentionally NOT created here.
    // Per-lane level meter
    meters[lane.id] = new Tone.Meter({ normalRange: false });
    fx[lane.id].vol.connect(meters[lane.id]);
    // Track which lazy FX nodes are wired into the chain.
    _fxInserted[lane.id] = { cho: false, wob: false, crush: false };
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
    // Dispose FX chain (null lazy nodes are skipped safely)
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
    delete _fxInserted[id];
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
      // Three slot gains act as fixed anchor points in the chain for the three
      // lazy FX nodes (crush → chorus → auto). They cost almost nothing (a
      // scalar multiply per block) and let us splice in real nodes later without
      // any ordering ambiguity regardless of which the user activates first.
      const slotAuto   = new Tone.Gain(1).connect(comp);
      const slotChorus = new Tone.Gain(1).connect(slotAuto);
      const slotCrush  = new Tone.Gain(1).connect(slotChorus);
      const dr = new Tone.Distortion({ distortion: 0.4, oversample: 'none' }).connect(slotCrush); dr.wet.value = 0;
      const ft = new Tone.Filter({ type: 'lowpass', frequency: 14000, Q: 0.7 }).connect(dr);
      // Post-fader send to shared reverb bus; gain=0 → dry by default.
      const reverbSend = new Tone.Gain(0); vol.connect(reverbSend); reverbSend.connect(_laneReverb);
      // crush/chorus/auto are null until first use (lazy-created by setLaneFX).
      return {
        filter: ft, drive: dr,
        crush: null, chorus: null, auto: null,
        slotCrush, slotChorus, slotAuto,
        comp, reverbSend, delay: dl, panner: pan, vol, input: ft, _cutType: 'lowpass',
      };
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
      // Widen the scheduler lookahead: profiling showed events landing ~30-50ms
      // in the past under main-thread load (negative lead) with the default 100ms.
      // 300ms gives the lookahead scheduler enough buffer to stay ahead of jank.
      Tone.getContext().lookAhead = 0.3;
      Tone.Transport.bpm.value = tempo;
      if (repeatId !== null) Tone.Transport.clear(repeatId);
      // Gated perf probe (?perf in URL): measures per-step callback duration and
      // scheduling "lead" (how far ahead of the audio clock each event is fired —
      // if it collapses toward 0, the main-thread scheduler is starving).
      const PERF = typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf');
      const _pf = { n: 0, sum: 0, max: 0, minLead: Infinity, late: 0 };
      repeatId = Tone.Transport.scheduleRepeat((t) => {
        const _cb0 = PERF ? performance.now() : 0;
        // Cheap arithmetic instead of Tone.Time('16n').toSeconds() — avoids a
        // string-parse + object alloc on every single step (GC-pressure spikes).
        const sixteenth = (60 / Tone.Transport.bpm.value) / 4;
        const barSeconds = stepsPerBar(song.meter) * sixteenth;
        const spb = stepsPerBar(song.meter);
        if (step % spb === 0) {
          if (pendingTranspose !== null) { song.transpose = pendingTranspose; pendingTranspose = null; }
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
        const swung = swingOffset(step, swing, sixteenth);
        for (const ev of eventsForStep(song, song.lanes, step, fillPat)) {
          const v = voices[ev.laneId];
          if (v) trigger(v, ev, t + swung, sixteenth, barSeconds);
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
        if (PERF) {
          const dur = performance.now() - _cb0;
          const lead = t - Tone.now();
          _pf.n++; _pf.sum += dur;
          if (dur > _pf.max) _pf.max = dur;
          if (lead < _pf.minLead) _pf.minLead = lead;
          if (lead < -Tone.getContext().lookAhead) _pf.late++;   // scheduled in the PAST = genuinely late
          if (_pf.n >= 64) {
            console.log('[gbperf]', JSON.stringify({
              lanes: song.lanes.length,
              avgMs: +(_pf.sum / _pf.n).toFixed(2),
              maxMs: +_pf.max.toFixed(2),
              minLeadMs: +(_pf.minLead * 1000).toFixed(1),
              late: _pf.late + '/' + _pf.n,
              lookAheadMs: +(Tone.getContext().lookAhead * 1000).toFixed(0),
            }));
            _pf.n = 0; _pf.sum = 0; _pf.max = 0; _pf.minLead = Infinity; _pf.late = 0;
          }
        }
        step++;
      }, '16n');
      Tone.Transport.start();
      playing = true;
    },
    stop() {
      Tone.Transport.stop();
      if (repeatId !== null) { Tone.Transport.clear(repeatId); repeatId = null; }
      step = 0; playing = false; pendingFill = null; activeFill = null; fillQueue = []; pendingTranspose = null;
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
      // Lazy-create per-lane waveform analyser on first scope read.
      if (!scopeLane[source] && fx[source]) {
        scopeLane[source] = new Tone.Waveform(1024);
        fx[source].vol.connect(scopeLane[source]);
      }
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
      else if (param === 'crush') {
        // Lazy-create BitCrusher on first use: splice it in place of slotCrush.
        if (!c.crush) {
          c.crush = new Tone.BitCrusher(4);
          c.crush.wet.value = 0;
          c.drive.disconnect(c.slotCrush);
          c.drive.connect(c.crush);
          c.crush.connect(c.slotChorus);   // slotCrush is no longer needed; slotChorus is now the bridge
          c.slotCrush.disconnect();
          c.slotCrush.dispose();
          c.slotCrush = null;
          if (_fxInserted[id]) _fxInserted[id].crush = true;
        }
        c.crush.wet.rampTo(v01, 0.08);
      }
      else if (param === 'delay')  c.delay.wet.rampTo(v01 * 0.5, 0.08);
      else if (param === 'vol')    c.vol.gain.rampTo(v01, 0.08);
      else if (param === 'pan')    c.panner.pan.rampTo((v01 - 0.5) * 2, 0.08);
      else if (param === 'reverb') c.reverbSend.gain.rampTo(v01 * 0.6, 0.05);
      else if (param === 'comp')   { c.comp.threshold.value = -30 * v01; c.comp.ratio.value = 1 + 7 * v01; }
      else if (param === 'res')    c.filter.Q.rampTo(0.7 + v01 * 14, 0.05);
      else if (param === 'fdbk')   c.delay.feedback.rampTo(v01 * 0.9, 0.05);
      else if (param === 'cho') {
        // Lazy-create Chorus on first use: splice it in place of slotChorus.
        if (!c.chorus) {
          c.chorus = new Tone.Chorus({ frequency: 1.5, delayTime: 3.5, depth: 0.7, wet: 0 }).start();
          // Find what's currently feeding slotChorus (crush if inserted, else drive).
          const upstream = c.crush ?? c.drive;
          upstream.disconnect(c.slotChorus);
          upstream.connect(c.chorus);
          c.chorus.connect(c.slotAuto);
          c.slotChorus.disconnect();
          c.slotChorus.dispose();
          c.slotChorus = null;
          if (_fxInserted[id]) _fxInserted[id].cho = true;
        }
        c.chorus.wet.rampTo(v01, 0.05);
      }
      else if (param === 'wob') {
        // Lazy-create AutoFilter on first use: splice it in place of slotAuto.
        if (!c.auto) {
          c.auto = new Tone.AutoFilter({ frequency: '8n', depth: 0.7, baseFrequency: 200, octaves: 4, wet: 0 }).start();
          // Find what's currently feeding slotAuto (chorus if inserted, else slotChorus, else crush, else drive).
          const upstream = c.chorus ?? c.slotChorus ?? c.crush ?? c.drive;
          upstream.disconnect(c.slotAuto);
          upstream.connect(c.auto);
          c.auto.connect(c.comp);
          c.slotAuto.disconnect();
          c.slotAuto.dispose();
          c.slotAuto = null;
          if (_fxInserted[id]) _fxInserted[id].wob = true;
        }
        c.auto.wet.rampTo(v01, 0.05);
      }
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
    setTranspose(semis) {
      if (!song) return;
      const n = semis | 0;
      if (keyQuantize && playing) { pendingTranspose = n; }
      else { song.transpose = n; pendingTranspose = null; }
    },
    getTranspose() { return song ? (song.transpose || 0) : 0; },
    setKeyQuantize(on) { keyQuantize = !!on; },
    getKeyQuantize() { return keyQuantize; },
    setSwing(v01) { swing = Math.max(0, Math.min(1, +v01 || 0)); },
    getSwing() { return swing; },
  };
}
