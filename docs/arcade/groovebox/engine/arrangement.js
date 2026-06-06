export function sectionAt(arrangement, songBar) {
  const total = arrangement.reduce((n, s) => n + s.bars, 0) || 1;
  let b = ((songBar % total) + total) % total;
  for (let i = 0; i < arrangement.length; i++) {
    const s = arrangement[i];
    if (b < s.bars) return { index: i, section: s, barInSection: b, isLastBar: b === s.bars - 1 };
    b -= s.bars;
  }
  const last = arrangement.length - 1;                       // fallback (shouldn't hit)
  return { index: last, section: arrangement[last], barInSection: 0, isLastBar: true };
}
