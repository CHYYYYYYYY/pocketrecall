/** Small deterministic intent layer for the hackathon voice flow.
 * No provider latency, and no claim to open-ended language reasoning. */
export function voiceIntent(input) {
  const text = String(input || '').trim().toLowerCase().replace(/[’‘]/g, "'");
  if (/取消寻找|不找了|^(?:please )?(?:cancel (?:the |my )?search|stop looking|stop searching|never ?mind)[.!?\s]*$/.test(text)) return 'cancel';
  if (/^(暂停|停一下|停止|安静|pause(?: (?:the )?(?:video|playback|observation))?|stop|quiet)[。！.!?\s]*$/.test(text)) return 'pause';
  if (/^(继续|继续观察|resume(?: (?:the )?(?:video|playback|observation))?|continue(?: watching)?|keep watching|start watching|go on)[。！.!?\s]*$/.test(text)) return 'resume';
  if (/拿到了|找到了|已经带上|我带上了|^(?:(?:i )?(?:got|found) (?:it|them)|i(?: have|'ve got| got) (?:it|them|my [a-z -]+)|found my [a-z -]+)[.!?\s]*$/.test(text)) return 'confirm';
  if (/^(下一个|下一件|接着找|next(?: one| item)?)[。！.!?\s]*$/.test(text)) return 'next';
  if (/出发|出门|离开|\b(?:leaving|head out|heading out|going out|let's go)\b/.test(text)) return 'departure';
  return 'find';
}

export function nextChecklistTarget(objects, confirmedIds = []) {
  const pending = objects.filter(o => o.priority === 'explicit' && !confirmedIds.includes(o.id));
  return pending.find(o => o.lastSeen) || pending[0] || null;
}
