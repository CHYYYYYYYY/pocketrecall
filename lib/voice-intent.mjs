/** Small deterministic intent layer for the hackathon voice flow.
 * No provider latency, and no claim to open-ended language reasoning. */
export function voiceIntent(input) {
  const text = String(input || '').trim().toLowerCase();
  if (/取消寻找|不找了|cancel (the )?search/.test(text)) return 'cancel';
  if (/^(暂停|停一下|停止|安静|pause|stop|quiet)[。！.!\s]*$/.test(text)) return 'pause';
  if (/^(继续|继续观察|resume|continue)[。！.!\s]*$/.test(text)) return 'resume';
  if (/拿到了|找到了|已经带上|我带上了|^(got it|found it|i have it)[.!\s]*$/.test(text)) return 'confirm';
  if (/^(下一个|下一件|接着找|next)[。！.!\s]*$/.test(text)) return 'next';
  if (/出发|出门|离开|leaving|head out/.test(text)) return 'departure';
  return 'find';
}

export function nextChecklistTarget(objects, confirmedIds = []) {
  const pending = objects.filter(o => o.priority === 'explicit' && !confirmedIds.includes(o.id));
  return pending.find(o => o.lastSeen) || pending[0] || null;
}
