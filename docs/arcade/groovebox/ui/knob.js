/**
 * makeKnob({ label, value, onChange })
 * Returns a DOM element: a 34px rotary knob with vertical-drag interaction.
 * value: 0..1; indicator rotates from -135deg (0) to +135deg (1).
 * Double-click (or double-tap) resets to initial value.
 * While dragging, a floating bubble shows the value (0–100).
 */

// One shared bubble on <body> — inside a knob strip it would be clipped by the
// strip's overflow scroll container. Only one pointer drags a knob at a time,
// so a singleton is enough.
let _bubble = null;
function getBubble() {
  if (!_bubble) {
    _bubble = document.createElement('div');
    _bubble.className = 'knob-bubble';
    document.body.appendChild(_bubble);
  }
  return _bubble;
}
let _bubbleHideTimer = null;

const fmt = v => Math.round(v * 100);

export function makeKnob({ label, value = 0, onChange, tip, k }) {
  const initial = value;
  let current = value;

  const wrapper = document.createElement('div');
  wrapper.className = 'knob';
  if (tip) wrapper.title = tip;
  if (k)   wrapper.dataset.k = k;

  const dial = document.createElement('div');
  dial.className = 'knob-dial';

  const ind = document.createElement('div');
  ind.className = 'knob-ind';

  const lbl = document.createElement('span');
  lbl.className = 'knob-lbl';
  lbl.textContent = label;

  // Persistent numeric readout (hidden unless body.gb-knob-values)
  const val = document.createElement('span');
  val.className = 'knob-val';

  dial.appendChild(ind);
  wrapper.appendChild(dial);
  wrapper.appendChild(lbl);
  wrapper.appendChild(val);

  function setRotation(v) {
    const deg = -135 + v * 270;
    ind.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  }

  function setValue(v) {
    current = Math.max(0, Math.min(1, v));
    setRotation(current);
    val.textContent = fmt(current);
    // Keep the visible bubble in sync for non-move value changes too
    // (double-tap / double-click reset while it is still showing).
    if (_bubble && _bubble.classList.contains('show')) _bubble.textContent = fmt(current);
    onChange(current);
  }

  setRotation(current);
  val.textContent = fmt(current);

  function showBubble() {
    const bubble = getBubble();
    const r = dial.getBoundingClientRect();
    // Clamp so the (~40px wide) bubble stays on-screen for edge-of-strip knobs
    const x = Math.max(26, Math.min(window.innerWidth - 26, r.left + r.width / 2));
    bubble.style.left = x + 'px';
    // Flip below the dial when there's no headroom (knob near viewport top)
    const below = r.top < 40;
    bubble.classList.toggle('below', below);
    bubble.style.top = below ? (r.bottom + 6) + 'px' : (r.top - 6) + 'px';
    bubble.textContent = fmt(current);
    clearTimeout(_bubbleHideTimer);
    bubble.classList.add('show');
  }
  function hideBubble() {
    clearTimeout(_bubbleHideTimer);
    _bubbleHideTimer = setTimeout(() => getBubble().classList.remove('show'), 350);
  }

  // Vertical drag
  let dragStartY = null;
  let dragStartValue = null;
  let lastTapAt = 0;
  let movedPx = 0;

  dial.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartValue = current;
    movedPx = 0;
    dial.setPointerCapture(e.pointerId);
    showBubble();
  });

  dial.addEventListener('pointermove', e => {
    if (dragStartY === null) return;
    const dy = e.clientY - dragStartY;
    movedPx = Math.max(movedPx, Math.abs(dy));
    setValue(dragStartValue - dy / 150);
  });

  // End the drag on up OR on cancel/lost-capture (OS gesture, blur, modal),
  // otherwise dragStartY stays set and later moves keep changing the value.
  const endDrag = e => {
    dragStartY = null;
    dragStartValue = null;
    if (e && e.pointerId != null) { try { dial.releasePointerCapture(e.pointerId); } catch {} }
    hideBubble();
  };
  dial.addEventListener('pointerup', e => {
    // Double-tap reset for touch, where dblclick is unreliable with pointer
    // capture. 10px slop: finger taps jitter well past a mouse's.
    if (e.pointerType === 'touch' && movedPx < 10) {
      const now = performance.now();
      if (now - lastTapAt < 350) { setValue(initial); lastTapAt = 0; }
      else lastTapAt = now;
    }
    endDrag(e);
  });
  dial.addEventListener('pointercancel', endDrag);
  dial.addEventListener('lostpointercapture', endDrag);

  dial.addEventListener('dblclick', () => {
    setValue(initial);
  });

  return wrapper;
}
