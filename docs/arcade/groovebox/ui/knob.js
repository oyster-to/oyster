/**
 * makeKnob({ label, value, onChange })
 * Returns a DOM element: a 34px rotary knob with vertical-drag interaction.
 * value: 0..1; indicator rotates from -135deg (0) to +135deg (1).
 * Double-click resets to initial value.
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

  dial.appendChild(ind);
  wrapper.appendChild(dial);
  wrapper.appendChild(lbl);

  function setRotation(v) {
    const deg = -135 + v * 270;
    ind.style.transform = `translateX(-50%) rotate(${deg}deg)`;
  }

  function setValue(v) {
    current = Math.max(0, Math.min(1, v));
    setRotation(current);
    onChange(current);
  }

  setRotation(current);

  // Vertical drag
  let dragStartY = null;
  let dragStartValue = null;

  dial.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartValue = current;
    dial.setPointerCapture(e.pointerId);
  });

  dial.addEventListener('pointermove', e => {
    if (dragStartY === null) return;
    const dy = e.clientY - dragStartY;
    setValue(dragStartValue - dy / 150);
  });

  // End the drag on up OR on cancel/lost-capture (OS gesture, blur, modal),
  // otherwise dragStartY stays set and later moves keep changing the value.
  const endDrag = e => {
    dragStartY = null;
    dragStartValue = null;
    if (e && e.pointerId != null) { try { dial.releasePointerCapture(e.pointerId); } catch {} }
  };
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);
  dial.addEventListener('lostpointercapture', endDrag);

  dial.addEventListener('dblclick', () => {
    setValue(initial);
  });

  return wrapper;
}
