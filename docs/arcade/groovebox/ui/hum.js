// Hum recording: mic → bar-aligned PCM → engine/hum.js transcribe → groove.
// The take records over the playing song; capture arms on the next bar line
// (engine onBarClock gives the bar's audio-clock time, the worklet stamps the
// capture stream on the same clock, so slicing is sample-accurate). All pitch
// analysis happens offline at stop — nothing touches the audio thread while
// the scheduler is playing.
import * as Tone from 'tone';
import { transcribe, fitBars, yinPitch, hzToNote } from '../engine/hum.js';
import { stepsPerBar } from '../engine/meter.js';

// Worklet posts every 128-frame block stamped with its context time; the
// first stamp anchors the stream, the rest is contiguous.
const WORKLET_SRC = `registerProcessor('hum-capture', class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage({ t: currentTime, d: ch.slice(0) });
    return true;
  }
});`;

// States: idle → arming (mic up, waiting for a bar line) → recording → idle.
// 'denied' (no mic permission) and 'empty' (take had no notes) flash briefly.
export function createHumRecorder(eng, { onState, onLanded }) {
  let state = 'idle', laneId = null;
  let stream = null, src = null, node = null, liveTimer = null;
  let chunks = [], t0 = -1, barStart = -1;
  let workletReady = null;

  const ctx = () => Tone.getContext().rawContext;
  const setState = (s, note) => { state = s; onState(laneId, s, note); };

  function ensureWorklet() {
    if (!workletReady) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      // Register on the standardized context's audioWorklet directly. NOT
      // Tone.getContext().addAudioWorkletModule — that caches a SINGLE module
      // promise per context, and the engine's BitCrusher (CRU knob / punch)
      // claims it at play(): whichever registers second silently never loads.
      // The standardized audioWorklet accepts any number of modules.
      workletReady = ctx().audioWorklet.addModule(url);
    }
    return workletReady;
  }

  function flash(s) { setState(s); setTimeout(() => { if (state === s) reset(); }, 1500); }

  function reset() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    eng.onBarClock(null);
    if (node) { node.port.onmessage = null; try { node.disconnect(); } catch {} }
    if (src) { try { src.disconnect(); } catch {} }
    if (stream) stream.getTracks().forEach(tr => tr.stop());
    setState('idle');
    laneId = null; stream = src = node = null; chunks = []; t0 = barStart = -1;
  }

  async function start(id) {
    laneId = id;
    setState('arming');
    // EC strips the song coming back through the speakers out of the mic —
    // YIN is monophonic, drum/bass bleed is its worst enemy. AGC off: it
    // drives hums into clipping, whose harmonics confuse pitch tracking.
    const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: false };
    try {
      // Chrome's virtual 'default' device follows the SYSTEM default mic.
      // Unconstrained, Chrome reuses its per-site pick instead, which can be a
      // dead device — e.g. the built-in mic while AirPods are connected, which
      // macOS mutes to silence. ideal: is too weak to override; exact: works.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO, deviceId: { exact: 'default' } } });
    } catch {
      // No 'default' virtual device outside Chrome — take the browser's pick.
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO }); }
      catch { flash('denied'); return; }
    }
    if (state !== 'arming') { stream.getTracks().forEach(tr => tr.stop()); return; }  // cancelled while waiting
    try {
      if (!eng.isPlaying()) await eng.play();
      await ensureWorklet();
      const c = ctx();
      src = c.createMediaStreamSource(stream);
      node = Tone.getContext().createAudioWorkletNode('hum-capture');
      src.connect(node);
      node.connect(c.destination);               // silent output keeps the node processing
    } catch (e) {
      console.error('hum: audio setup failed', e);
      reset();
      return;
    }
    node.port.onmessage = (e) => {
      if (t0 < 0) t0 = e.data.t;
      chunks.push(e.data.d);
    };
    eng.onBarClock((t, barInPattern) => {
      // Arm at a PATTERN start (groove bar 0 must mean pattern bar 0, or the
      // take plays back rotated), and only once capture is flowing so the
      // bar line is inside the stream.
      if (barStart < 0 && t0 >= 0 && barInPattern === 0) {
        barStart = t;
        setState('recording');
        liveTimer = setInterval(liveNote, 250);  // 'hearing: A3' readout
      }
    });
  }

  // Run YIN over the freshest 2048 samples for the button readout.
  function liveNote() {
    const need = 2048, frame = new Float32Array(need);
    let fill = need;
    for (let i = chunks.length - 1; i >= 0 && fill > 0; i--) {
      const ch = chunks[i], take = Math.min(fill, ch.length);
      frame.set(ch.subarray(ch.length - take), fill - take);
      fill -= take;
    }
    if (fill > 0) return;
    const hz = yinPitch(frame, ctx().sampleRate);
    setState('recording', hz ? hzToNote(hz) : null);
  }

  function stopTake() {
    const c = ctx(), sr = c.sampleRate, stopAt = c.currentTime;
    const myChunks = chunks, myT0 = t0, myBarStart = barStart, lid = laneId;
    if (myBarStart < 0) { reset(); return; }     // stopped before a bar line arrived
    reset();

    const total = myChunks.reduce((n, ch) => n + ch.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const ch of myChunks) { all.set(ch, off); off += ch.length; }
    const pcm = all.subarray(Math.max(0, Math.round((myBarStart - myT0) * sr)));

    const song = eng.getSong();
    const bpm = Tone.Transport.bpm.value;
    const barSec = stepsPerBar(song.meter) * (60 / bpm / 4);
    // ceil: a partial bar you hummed into counts; -0.05 forgives stopping just
    // past a bar line.
    const recorded = Math.max(1, Math.ceil((stopAt - myBarStart) / barSec - 0.05));
    const bars = transcribe(pcm, sr, {
      bpm, meter: song.meter, key: song.key ?? null,
      transpose: song.transpose || 0, bars: fitBars(recorded),
      lift: 57,   // hums live ~C3; lift into melody register (piano roll floor A3)
    });
    // Forensics while the feature is young: the raw take, inspectable from the
    // console as __humTake (pitch tuning needs real-mic evidence, not guesses).
    window.__humTake = { sampleRate: sr, pcm, recorded, bars };
    console.info(`hum: ${(pcm.length / sr).toFixed(1)}s take, ${recorded} bar(s), ${bars.flat().length} note(s)`);
    if (bars.every(b => !b.length)) { laneId = lid; flash('empty'); return; }

    const names = Object.keys(eng.getGrooves()[lid] || {});
    let n = 1;
    while (names.includes(`hum ${n}`)) n++;
    const name = `hum ${n}`;
    eng.addGroove(lid, name, bars);
    eng.setLaneGroove(lid, name);                // instant swap-in: audible next bar
    onLanded(lid, name);
  }

  return {
    toggle(id) {
      if (state === 'idle') start(id);
      else if (id === laneId && state === 'recording') stopTake();
      else if (id === laneId && state === 'arming') reset();   // cancel before the bar line
    },
    // Transport stop is the natural "I'm done" gesture — land the take (the
    // recorder would otherwise pulse forever with its bar clock dead).
    transportStopped() {
      if (state === 'recording') stopTake();
      else if (state === 'arming') reset();
    },
    cancel() { if (state !== 'idle') reset(); },   // discard, never land

    stateFor(id) { return id === laneId ? state : 'idle'; },
  };
}
