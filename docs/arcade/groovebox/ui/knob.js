/**
 * makeKnob({ label, value, onChange })
 * Returns a DOM element: a 34px rotary knob with vertical-drag interaction.
 * value: 0..1; indicator rotates from -135deg (0) to +135deg (1).
 * Double-click (or double-tap) resets to initial value.
 * While dragging, a floating bubble shows the value (0–100).
 */
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

  // Persistent numeric readout (hidden unless body.gbm-knobval)
  const val = document.createElement('span');
  val.className = 'knob-val';

  // Floating value bubble while dragging (position:fixed → escapes overflow clips)
  const bubble = document.createElement('div');
  bubble.className = 'knob-bubble';

  dial.appendChild(ind);
  wrapper.appendChild(dial);
  wrapper.appendChild(lbl);
  wrapper.appendChild(val);
  wrapper.appendChild(bubble);

  const fmt = v => Math.round(v * 100);

  function setRotation(v) {
    const deg = -135 + v * 270;
    ind.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  }

  function setValue(v) {
    current = Math.max(0, Math.min(1, v));
    setRotation(current);
    val.textContent = fmt(current);
    bubble.textContent = fmt(current);
    onChange(current);
  }

  setRotation(current);
  val.textContent = fmt(current);

  let bubbleHideTimer = null;
  function showBubble() {
    const r = dial.getBoundingClientRect();
    bubble.style.left = (r.left + r.width / 2) + 'px';
    bubble.style.top = (r.top - 6) + 'px';
    bubble.textContent = fmt(current);
    clearTimeout(bubbleHideTimer);
    bubble.classList.add('show');
  }
  function hideBubble() {
    clearTimeout(bubbleHideTimer);
    bubbleHideTimer = setTimeout(() => bubble.classList.remove('show'), 350);
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
    // Double-tap reset for touch, where dblclick is unreliable with pointer capture
    if (e.pointerType === 'touch' && movedPx < 5) {
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
