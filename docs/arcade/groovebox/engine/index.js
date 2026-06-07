import * as Tone from 'tone';
import { stepsPerBar } from './meter.js';
import { createVoiceForType, trigger } from './voices.js';
import { laneByType, toggleMute as _toggleMute, soloExclusive as _soloExclusive, toggleDrumMute as _toggleDrumMute, toggleDrumSolo as _toggleDrumSolo, addLane as _addLane, duplicateLane as _duplicateLane, removeLane as _removeLane, renameLane as _renameLane, moveLane as _moveLane } from './lanes.js';
import { deriveKey } from './song.js';
import { flattenSong } from './flatten.js';
import {
  eventsForStepV2, advanceTarget, targetPattern,
  addPattern as _addPattern, duplicatePattern as _duplicatePattern, removePattern as _removePattern,
  appendToChain as _appendToChain,
  removeChainAt as _removeChainAt, moveChain as _moveChain,
  setDrumStep as _setDrumStep, toggleNote as _toggleNote,
  setLaneGroove as _setLaneGroove, addGroove as _addGroove, grooveFor,
  setGrooveBars as _setGrooveBars,
} from './patterns.js';
import { PUNCH_NEUTRAL, MODULE_PARAMS, scaleValue, durationToSeconds, gateEventsForStep, laneInPunchBus, engageCapture, releaseCapture } from './punch.js';
import { DEFAULT_PRESETS, validatePreset } from './punch-presets.js';

export function createEngine() {
  let song = null, step = 0, started = false, repeatId = null, tempo = 120, playing = false, onStepCb = null, pendingFill = null, activeFill = null, fillQueue = [];
  // Playback target — what is driving sound. Follows the LAST CLICK even while
  // stopped (spec): clicking sets `target` directly when stopped, or queues
  // `pendingTarget` for the next bar boundary when playing. play() starts the
  // current target from its top bar; stop() keeps the target.
  let target = { kind: 'chain', pos: 0, barInPattern: 0 };
  let pendingTarget = null;      // applied at the next bar boundary
  let editIdx = 0;               // pattern open in the editors
  let masterComp = null, masterRev = null, masterVol = null, masterPan = null, masterWidth = null, masterEQ = null;
  let _widthOn = false;   // is the StereoWidener spliced into the master chain?
  // Punch v3: pre-wired neutral punch bus; presets are data (punch-presets.js)
  // executed by the automation runner (_runAutomation) over MODULE_PARAMS.
  let punchGate = null, punchCrush = null, punchFilter = null, punchThrow = null, punchTape = null;
  const _punchCaptures = new Map();              // 'laneId|paramId' → { value: knob value at first engage, count }
  let punchPresets = DEFAULT_PRESETS;            // replaced via setPunchPresets (validated)
  const _slotHeld = new Array(DEFAULT_PRESETS.length).fill(false);
  const _gates = new Map();                      // slot → { depth, division, laneIds } (preview uses 'preview')
  let _tapeActive = false;                       // transport.tapeStop engaged (owns the BUS punchGate; lane-fader gate is independent)
  let _gateReturnPending = false;                // tapeStop released → gate returns on-grid
  const _pendingQuantized = [];                  // [{ when: 'bar'|'pattern', fn, slot, on }] — slot/on drive quick-tap annihilation
  let _previewMask;                              // editor TEST: draft's lane mask while held (undefined = no preview)
  let meterL = null, meterR = null;
  let scopeMaster = null, scopeLane = {};
  // Per-lane keyed maps (by lane.id)
  let voices = {}, fx = {}, meters = {};
  // Tracks which lazy FX nodes have been inserted into the chain per lane.
  // Shape: { [laneId]: { cho: bool, wob: bool, crush: bool } }
  let _fxInserted = {};
  // Stored after ensure() so buildLane can be called post-graph-init
  let _makeFX = null, _masterIn = null, _laneReverb = null;

  // Lazy BitCrusher splice (shared by the CRU knob and punch pre-build):
  // creating it at config time avoids the splice click at perform time.
  function _ensureLaneCrush(id) {
    const c = fx[id];
    if (!c || c.crush) return;
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

  // v4 per-lane punch: automations drive the masked lanes' OWN fx params via
  // _laneParam (capture knob value at engage, restore at last release —
  // refcounted in _punchCaptures). Only tapeStop still uses the shared bus.
  function _laneParam(f, id) {
    if (id === 'filter.freq')    return f.filter.frequency;
    if (id === 'filter.Q')       return f.filter.Q;
    if (id === 'delay.wet')      return f.delay.wet;
    if (id === 'delay.feedback') return f.delay.feedback;
    if (id === 'crusher.wet')    return f.crush ? f.crush.wet : null;
    return null;
  }
  function _maskedLanes(mask) {
    return song ? song.lanes.filter(l => mask == null || mask.includes(l.type)) : [];
  }
  // Pre-build lazy nodes any preset needs, at config time (no perform-time click).
  function _prebuildPunchNodes(presets) {
    if (!started) return;
    for (const p of presets) {
      if (!p?.automations?.some(a => a.module === 'crusher')) continue;
      for (const lane of _maskedLanes(p.lanes ?? null)) _ensureLaneCrush(lane.id);
    }
  }

  // Per-preset lane targeting: rebuild every lane's punch/clean crossfade from
  // chips ∩ the union of held presets' masks. Called on every press/release,
  // chip toggle, and song load. Routing swaps are inaudible while the bus is
  // neutral, so immediate (un-quantized) re-routing is safe.
  function _recomputePunchRouting() {
    if (!song) return;
    const masks = [];
    for (let s = 0; s < _slotHeld.length; s++) {
      if (_slotHeld[s]) masks.push(punchPresets[s]?.lanes ?? null);
    }
    if (_previewMask !== undefined) masks.push(_previewMask);   // editor TEST counts as a held pad
    for (const lane of song.lanes) {
      const f = fx[lane.id];
      if (!f || !f.toPunch) continue;
      const inBus = laneInPunchBus(lane, masks);
      f.toPunch.gain.rampTo(inBus ? 1 : 0, 0.01);
      f.toClean.gain.rampTo(inBus ? 0 : 1, 0.01);
    }
  }

  // Punch automation runner: executes one preset automation (engage or
  // release) against the live graph. gate.* chops per-lane faders (state in
  // _gates, keyed by slot); transport.tapeStop drives the shared bus; every
  // other param resolves per masked lane via _laneParam, with knob values
  // captured/restored through _punchCaptures.
  function _runAutomation(a, on, timing, atTime, amount = 1, mask = null, slotKey = 'preview') {
    const id = `${a.module}.${a.param}`;
    const reg = MODULE_PARAMS[id];
    if (!reg) return;
    const ramp = Math.max(durationToSeconds(on ? a.engage?.ramp : a.release?.ramp, timing), 0.003);
    if (id === 'gate.depth') {
      if (on) {
        // Chop each masked lane's fader (scaled by its captured knob value)
        // in the step callback. Gate state is PER SLOT — two gate pads held
        // together (e.g. default STUTTER + STUTTER BASS) must not overwrite
        // each other's lane lists (review: stranded captures).
        const laneIds = [];
        for (const lane of _maskedLanes(mask)) {
          const f = fx[lane.id];
          if (!f) continue;
          engageCapture(_punchCaptures, lane.id + '|vol', f.vol.gain.value);
          laneIds.push(lane.id);
        }
        _gates.set(slotKey, { depth: (typeof a.to === 'number' ? a.to : 1) * amount, division: a.division || '1/16', laneIds });
      } else {
        const g = _gates.get(slotKey);
        _gates.delete(slotKey);
        for (const laneId of (g ? g.laneIds : [])) {
          const v = releaseCapture(_punchCaptures, laneId + '|vol');
          if (v != null && fx[laneId]) fx[laneId].vol.gain.rampTo(v, Math.max(ramp, 0.01), atTime);
        }
      }
      return;
    }
    if (id === 'transport.tapeStop') {
      if (on) {
        // Slump: delayTime + gate fade over the same window — the gate sits
        // before the tape delay, so the line keeps emitting the slowing audio.
        // rampTo pins current values (no cancel-then-revert clicks).
        _tapeActive = true; _gateReturnPending = false;
        // `to` is the tapeStop depth fraction (1 = full 0.6s slump — v2 parity).
        const tapeDepth = 0.6 * Math.min(Math.max(a.to, 0), 1) * amount;
        punchGate.gain.rampTo(0, ramp, atTime);
        punchTape.delayTime.rampTo(tapeDepth, ramp, atTime);
      } else {
        // Strict release order (v2 safeguard 2), click-free on quick taps:
        // close fast, freeze the slump, snap delayTime back once silent,
        // gate returns on-grid via the step callback flag.
        _tapeActive = false;
        const now = Tone.now();
        punchGate.gain.rampTo(0, 0.003);
        punchTape.delayTime.cancelAndHoldAtTime(now);
        punchTape.delayTime.setValueAtTime(PUNCH_NEUTRAL.tapeDelay, now + 0.005);
        _gateReturnPending = true;
      }
      return;
    }
    const scale = a.scale || reg.scale;
    for (const lane of _maskedLanes(mask)) {
      const f = fx[lane.id];
      const param = f && _laneParam(f, id);
      if (!param) continue;
      const key = lane.id + '|' + id;
      if (on) {
        // 'neutral' from = the lane's CURRENT (knob) value — captured once,
        // refcounted across overlapping pads, restored at last release.
        const captured = engageCapture(_punchCaptures, key, param.value);
        const from = (a.from === 'neutral' || a.from == null) ? captured : a.from;
        // atTime (quantized actions): schedule AT the boundary's audio time —
        // the callback fires ~lookahead early.
        param.rampTo(scaleValue(from, a.to, amount, scale), ramp, atTime);
      } else {
        const v = releaseCapture(_punchCaptures, key);
        if (v != null) param.rampTo(v, ramp, atTime);
      }
    }
  }

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
      // New-style voices own their teardown; legacy flat shapes get the loop.
      if (typeof v.dispose === 'function') { try { v.dispose(); } catch (_) {} }
      else for (const node of Object.values(v)) { try { node.dispose?.(); } catch (_) {} }
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
    // StereoWidener bypassed by default — its mid/side processing weakens per-lane
    // pan and drops level on a mono-ish mix. Spliced in only when WID leaves centre.
    masterWidth = new Tone.StereoWidener(0.5);
    masterEQ   = new Tone.EQ3({ low: 0, mid: 0, high: 0 }).connect(masterRev);
    const masterIn = masterEQ;
    // Punch bus (v2 channel-assign): armed lanes route vol → toPunch → this
    // chain → masterIn; unarmed lanes go vol → toClean → masterIn. Pre-wired
    // and neutral — engaging a pad is param ramps only (no graph surgery).
    punchTape   = new Tone.Delay({ delayTime: PUNCH_NEUTRAL.tapeDelay, maxDelay: 1 }).connect(masterIn);
    punchThrow  = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: MODULE_PARAMS['delay.feedback'].neutral, wet: PUNCH_NEUTRAL.throwWet }).connect(punchTape);
    punchFilter = new Tone.Filter({ type: 'lowpass', frequency: PUNCH_NEUTRAL.filterFreq, Q: PUNCH_NEUTRAL.filterQ }).connect(punchThrow);
    punchCrush  = new Tone.BitCrusher(6); punchCrush.wet.value = PUNCH_NEUTRAL.crushWet; punchCrush.connect(punchFilter);
    punchGate   = new Tone.Gain(PUNCH_NEUTRAL.gateGain).connect(punchCrush);
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
      // Punch-bus split: complementary gains (armed: toPunch 1 / toClean 0).
      // Arming is a 10ms crossfade on these — never a connect/disconnect.
      const vol = new Tone.Gain(1);
      const toClean = new Tone.Gain(0); vol.connect(toClean); toClean.connect(dest);
      const toPunch = new Tone.Gain(1); vol.connect(toPunch); toPunch.connect(punchGate);
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
        comp, reverbSend, delay: dl, panner: pan, vol, toPunch, toClean, input: ft, _cutType: 'lowpass',
      };
    };
    _masterIn = masterIn;
    // Waveform analyser for master (sink — doesn't alter audio chain).
    scopeMaster = new Tone.Waveform(1024);
    masterComp.connect(scopeMaster);
    // Build per-lane graph
    buildLaneGraph(song.lanes);
    started = true;
    _prebuildPunchNodes(punchPresets);   // after started flips — the guard would no-op it otherwise
  }

  return {
    load(s) {
      const v2 = (s.patterns && s.chain) ? s : flattenSong(s);
      song = v2;
      editIdx = 0; pendingTarget = null;
      target = { kind: 'chain', pos: 0, barInPattern: 0 };
      tempo = (typeof v2.bpm === 'number' && isFinite(v2.bpm)) ? v2.bpm : tempo;
      if (started) {
        for (const id of Object.keys(voices)) {
          if (!v2.lanes.some(l => l.id === id)) disposeLane(id);
        }
        for (const lane of v2.lanes) {
          if (!voices[lane.id]) buildLane(lane);
          // Re-apply tone to SURVIVING melody voices: the voice (keyed by lane id)
          // is reused across a song switch, but the new song carries its own
          // lane.tone. Without this the reused oscillator keeps the previous
          // song's (or the user's last-dialed) tone while the UI shows the new
          // one — an audible/visual desync after switching songs.
          else if (lane.type === 'melody' && lane.tone && voices[lane.id]?.lead) {
            voices[lane.id].lead.set({ oscillator: { type: lane.tone, width: 0.3 } });
          }
        }
        // Re-sync punch routing for REUSED lane graphs (song-switch desync).
        _recomputePunchRouting();
        _prebuildPunchNodes(punchPresets);
      }
    },
    async play() {
      if (!song) throw new Error('no song loaded');
      if (playing) return;                                   // ignore double-play (don't stack callbacks)
      await Tone.start(); ensure();
      step = 0;
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
          if (step === 0) {
            target = { ...target, barInPattern: 0 };       // play restarts the current target from its top bar
          } else if (pendingTarget) {
            target = pendingTarget; pendingTarget = null;  // switch at bar boundary
          } else {
            target = advanceTarget(target, song);
          }
          const prevFill = activeFill;
          activeFill = fillQueue.length ? fillQueue.shift() : pendingFill;
          pendingFill = null;
          if (prevFill && !activeFill) {
            const drumsVoice = voices[laneByType(song.lanes, 'drums')?.id];
            if (drumsVoice) drumsVoice.crash.triggerAttackRelease('8n', t, 0.9);
          }
        }
        const patternIdx = targetPattern(target, song);
        const fillPat = activeFill ? (song.fills?.[activeFill] ?? null) : null;
        for (const ev of eventsForStepV2(song, patternIdx, target.barInPattern, step % spb, fillPat, song.transpose || 0)) {
          const v = voices[ev.laneId];
          if (v) trigger(v, ev, t, sixteenth, barSeconds);
        }
        // Punch v3: quantized actions at boundaries, on-grid gate return after
        // tapeStop, then GATE chops (tapeStop owns the gate while active).
        if (_pendingQuantized.length && step % spb === 0) {
          const patternStart = target.barInPattern === 0;
          // FIFO: engage-then-release queued before the same boundary must run
          // in press order, or the preset ends up stuck engaged (PR review).
          const due = [];
          for (let i = 0; i < _pendingQuantized.length; ) {
            const p = _pendingQuantized[i];
            if (p.when === 'bar' || (p.when === 'pattern' && patternStart)) {
              due.push(p.fn); _pendingQuantized.splice(i, 1);
            } else i++;
          }
          for (const fn of due) fn(t);
        }
        if (_gateReturnPending) {
          punchGate.gain.setValueAtTime(0, t);
          punchGate.gain.linearRampToValueAtTime(PUNCH_NEUTRAL.gateGain, t + 0.003);
          _gateReturnPending = false;
        }
        for (const g of _gates.values()) {
          for (const laneId of g.laneIds) {
            const f = fx[laneId];
            const cap = _punchCaptures.get(laneId + '|vol');
            if (!f || !cap) continue;
            for (const [at, v] of gateEventsForStep(t, sixteenth, step, g.division, g.depth))
              f.vol.gain.linearRampToValueAtTime(v * cap.value, at);
          }
        }
        if (onStepCb) {
          const s = step; const qSnap = fillQueue.slice();
          const tSnap = { kind: target.kind, chainPos: target.kind === 'chain' ? target.pos : -1,
                          patternIdx: targetPattern(target, song), barInPattern: target.barInPattern };
          // The sounding chord is derived in the UI from tSnap (patternIdx +
          // barInPattern) against that pattern's own chords — no global clock.
          Tone.Draw.schedule(() => {
            onStepCb({ absStep: s, bar: Math.floor(s / spb), stepInBar: s % spb,
                       fill: activeFill, queue: qSnap, target: tSnap });
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
      step = 0; playing = false; pendingFill = null; activeFill = null; fillQueue = []; pendingTarget = null;
      // Punch pads release with the transport. rampTo pins current values
      // (no cancel-then-revert clicks); delayTime snaps back after the brief
      // gate settle so any reverb tail doesn't doppler.
      _slotHeld.fill(false);
      _gates.clear(); _tapeActive = false; _gateReturnPending = false; _pendingQuantized.length = 0;
      _previewMask = undefined;
      // Restore every captured lane param to its knob value.
      for (const [key, cap] of _punchCaptures) {
        const [laneId, paramId] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
        const f = fx[laneId];
        if (!f) continue;
        const param = paramId === 'vol' ? f.vol.gain : _laneParam(f, paramId);
        if (param) param.rampTo(cap.value, 0.02);
      }
      _punchCaptures.clear();
      _recomputePunchRouting();
      if (started) {
        const now = Tone.now();
        punchGate.gain.rampTo(PUNCH_NEUTRAL.gateGain, 0.01);
        punchTape.delayTime.cancelAndHoldAtTime(now);
        punchTape.delayTime.setValueAtTime(PUNCH_NEUTRAL.tapeDelay, now + 0.015);
        punchCrush.wet.rampTo(PUNCH_NEUTRAL.crushWet, 0.05);
        punchFilter.frequency.rampTo(PUNCH_NEUTRAL.filterFreq, 0.05);
        punchFilter.Q.rampTo(PUNCH_NEUTRAL.filterQ, 0.05);
        punchThrow.wet.rampTo(PUNCH_NEUTRAL.throwWet, 0.05);
        punchThrow.feedback.rampTo(MODULE_PARAMS['delay.feedback'].neutral, 0.05);
      }
    },
    setTempo(bpm) { if (typeof bpm === 'number' && isFinite(bpm)) { tempo = bpm; Tone.Transport.bpm.value = bpm; } },
    onStep(cb) { onStepCb = cb; },
    isPlaying()  { return playing; },
    getSong() { return song; },
    getLanes() { return song ? song.lanes : []; },
    // Lane ops by id
    toggleMute(id)          { return song ? _toggleMute(song.lanes, id) : false; },
    toggleSolo(id)          { return song ? _soloExclusive(song.lanes, id) : false; },
    triggerFill(name)       { pendingFill = name; },
    // Punch v3: slot-based momentary trigger — punch(slot, true) on press,
    // punch(slot, false) on release. Executes the slot's preset automations
    // (data, not code) with engage/release quantize.
    punch(slot, on) {
      if (!started || !punchPresets[slot]) return;
      on = !!on;
      if (_slotHeld[slot] === on) return;            // ignore repeat echoes
      _slotHeld[slot] = on;
      _recomputePunchRouting();
      const preset = punchPresets[slot];
      const beatSeconds = 60 / Tone.Transport.bpm.value;
      const timing = {
        sixteenth: beatSeconds / 4,
        beatSeconds,
        barSeconds: stepsPerBar(song.meter) * (beatSeconds / 4),
      };
      const q = on ? preset.engageQuantize : preset.releaseQuantize;
      const amount = preset.amount ?? 1;
      const mask = preset.lanes ?? null;
      // Quick-tap correctness: an UNFIRED opposite action for this slot
      // annihilates instead of stacking (quantized engage + instant release
      // would otherwise fire the engage at the bar with the pad already up).
      for (let i = 0; i < _pendingQuantized.length; i++) {
        if (_pendingQuantized[i].slot === slot && _pendingQuantized[i].on === !on) {
          _pendingQuantized.splice(i, 1);
          return;
        }
      }
      const run = (atTime) => { for (const a of preset.automations) _runAutomation(a, on, timing, atTime, amount, mask, slot); };
      if (q === 'immediate' || !playing) run();
      else _pendingQuantized.push({ when: q, fn: run, slot, on });
    },
    setPunchPresets(presets) {
      if (Array.isArray(presets) && presets.length === DEFAULT_PRESETS.length && presets.every(validatePreset)) {
        punchPresets = presets;
        _prebuildPunchNodes(punchPresets);
      }
      return punchPresets;
    },
    getPunchPresets() { return punchPresets; },
    // v3.5 editor TEST pad: audition an UNSAVED draft preset momentarily.
    // Same runner path as punch(); no slot state. UI gates on isPlaying().
    punchPreview(preset, on) {
      if (!started || !validatePreset(preset)) return;
      // The draft's lane mask must route like a held pad, or TEST plays
      // through the idle all-lanes bus regardless of "active on".
      _previewMask = on ? (preset.lanes ?? null) : undefined;
      _recomputePunchRouting();
      const amount = preset.amount ?? 1;
      const beatSeconds = 60 / Tone.Transport.bpm.value;
      const timing = {
        sixteenth: beatSeconds / 4,
        beatSeconds,
        barSeconds: stepsPerBar(song.meter) * (beatSeconds / 4),
      };
      if (on) _prebuildPunchNodes([preset]);   // draft may use crush on lanes without the node yet
      for (const a of preset.automations) _runAutomation(a, !!on, timing, undefined, amount, preset.lanes ?? null, 'preview');
    },
    isPlaying() { return playing; },
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
    // ── patterns + chain ──────────────────────────────────────────────────────
    getPatterns()        { return song ? song.patterns : []; },
    getChain()           { return song ? song.chain : []; },
    getGrooves()         { return song ? song.grooves : {}; },
    getEditGroove(laneId){ return song ? grooveFor(song, editIdx, laneId) : null; },
    getEditPatternIndex(){ return editIdx; },
    selectPattern(i) {
      if (!song || !song.patterns[i]) return;
      editIdx = i;
      const next = { kind: 'pattern', idx: i, barInPattern: 0 };
      if (playing) pendingTarget = next; else target = next;
    },
    playChain(pos) {
      if (!song) return;
      const p = Math.max(0, Math.min(pos, song.chain.length - 1));
      const next = { kind: 'chain', pos: p, barInPattern: 0 };
      if (playing) pendingTarget = next; else target = next;
    },
    getPlaybackTarget() {
      return { kind: target.kind, chainPos: target.kind === 'chain' ? target.pos : -1,
               patternIdx: song ? targetPattern(target, song) : 0, barInPattern: target.barInPattern,
               pending: !!pendingTarget };
    },
    addPattern()            { return song ? _addPattern(song, editIdx) : null; },
    duplicatePattern(i)     { return song ? _duplicatePattern(song, i) : null; },
    setLaneGroove(laneId, grooveName) { return song ? _setLaneGroove(song, editIdx, laneId, grooveName) : false; },
    addGroove(laneId, name, value) { return song ? _addGroove(song, laneId, name, value) : false; },
    setGrooveBars(laneId, n) {
      if (!song) return null;
      const g = grooveFor(song, editIdx, laneId);
      return g ? _setGrooveBars(song, laneId, g.name, n) : null;
    },
    removePattern(i) {
      if (!song) return false;
      const chainLenBefore = song.chain.length;
      if (!_removePattern(song, i)) return false;
      if (i < editIdx) editIdx--;
      if (editIdx >= song.patterns.length) editIdx = song.patterns.length - 1;
      // intentional coarse sanitization: any pattern loop resets to chain start on delete (deletes are rare; avoids reindex bookkeeping)
      if (target.kind === 'pattern') target = { kind: 'chain', pos: 0, barInPattern: 0 };
      if (target.kind === 'chain') {
        if (song.chain.length !== chainLenBefore) {
          // Chain changed (chips for pattern i were removed); precise repositioning is ambiguous — reset to start
          target = { kind: 'chain', pos: 0, barInPattern: 0 };
        } else if (target.pos >= song.chain.length) {
          target = { kind: 'chain', pos: 0, barInPattern: 0 };
        }
      }
      pendingTarget = null;
      return true;
    },
    appendToChain(i)        { if (song) _appendToChain(song, i); },
    removeChainAt(pos) {
      if (!song || !_removeChainAt(song, pos)) return false;
      if (target.kind === 'chain') {
        if (pos < target.pos) target = { ...target, pos: target.pos - 1 };
        else if (pos === target.pos) target = { kind: 'chain', pos: Math.min(target.pos, song.chain.length - 1), barInPattern: 0 };
      }
      return true;
    },
    moveChain(from, to)     { if (song) _moveChain(song, from, to); },
    setDrumStep(laneId, voice, barIdx, stepIdx, on) {
      if (!song) return;
      const g = grooveFor(song, editIdx, laneId);
      if (g) _setDrumStep(song, laneId, g.name, barIdx, voice, stepIdx, on);
    },
    toggleNote(laneId, barIdx, stepIdx, note, dur) {
      if (!song) return;
      const g = grooveFor(song, editIdx, laneId);
      if (g) _toggleNote(song, laneId, g.name, barIdx, stepIdx, note, dur);
    },
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
        _ensureLaneCrush(id);
        c.crush.wet.rampTo(v01, 0.08);
      }
      else if (param === 'delay')  c.delay.wet.rampTo(v01 * 0.5, 0.08);
      else if (param === 'vol')    c.vol.gain.rampTo(v01, 0.08);
      else if (param === 'pan')    c.panner.pan.rampTo((v01 - 0.5) * 2, 0.08);
      else if (param === 'reverb') c.reverbSend.gain.rampTo(v01 * 0.6, 0.05);
      else if (param === 'comp')   { c.comp.threshold.rampTo(-30 * v01, 0.05); c.comp.ratio.rampTo(1 + 7 * v01, 0.05); }
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
      else if (param === 'comp'   && masterComp)  { masterComp.threshold.rampTo(-30 * v01, 0.05); masterComp.ratio.rampTo(1 + 7 * v01, 0.05); }
      else if (param === 'vol'    && masterVol)   masterVol.gain.rampTo(v01, 0.05);
      else if (param === 'bal'    && masterPan)   masterPan.pan.rampTo((v01 - 0.5) * 2, 0.05);
      else if (param === 'width'  && masterWidth && masterEQ && masterRev) {
        const engage = Math.abs(v01 - 0.5) > 0.001;          // 0.5 = neutral → bypass
        if (engage && !_widthOn) {
          try { masterEQ.disconnect(masterRev); } catch (_) {}
          masterEQ.connect(masterWidth); masterWidth.connect(masterRev);
          _widthOn = true;
        } else if (!engage && _widthOn) {
          try { masterEQ.disconnect(masterWidth); masterWidth.disconnect(masterRev); } catch (_) {}
          masterEQ.connect(masterRev);
          _widthOn = false;
        }
        if (_widthOn) masterWidth.width.rampTo(v01, 0.05);
      }
      else if (param === 'lo'     && masterEQ)    masterEQ.low.rampTo((v01 - 0.5) * 24, 0.05);
      else if (param === 'hi'     && masterEQ)    masterEQ.high.rampTo((v01 - 0.5) * 24, 0.05);
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
    // ─── harmony (chords belong to PATTERNS) ────────────────────────────────────
    getKey()           { return song?.key ?? null; },
    getPatternChords(i){ return song?.patterns[i]?.chords ?? null; },
    // Set the EDIT pattern's chords (the parsed array, one chord per bar, cycling).
    // Relative-groove lanes read these live, so the change is audible immediately.
    // song.key is re-derived from EVERY pattern's chords (an authored key is
    // replaced on the first edit — acceptable).
    setPatternChords(chords) {
      if (!song) return;
      const pat = song.patterns[editIdx];
      if (!pat) return;
      if (Array.isArray(chords) && chords.length) pat.chords = chords;
      else delete pat.chords;
      const all = song.patterns.flatMap(p => p.chords ?? []);
      const key = deriveKey(all);
      if (key) song.key = key; else delete song.key;
    },
    setTranspose(semis) {
      if (!song) return;
      song.transpose = semis | 0;
    },
    getTranspose() { return song ? (song.transpose || 0) : 0; },
  };
}
