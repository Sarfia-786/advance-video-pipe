export function captionErrorMessage(error, copy) {
  const location = error.word ? copy.word + ' ' + error.word : error.cue ? copy.cue + ' ' + error.cue : '';
  return (location ? location + ' — ' : '') + (copy[error.code] || copy.network);
}

export function saveCaptionFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadCaptionTrack(track, copy, format = 'srt') {
  try {
    const response = await fetch('/api/platform/v1/captions/' + format, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(track),
    });
    if (!response.ok) {
      const { error } = await response.json();
      return captionErrorMessage(error, copy);
    }
    saveCaptionFile(await response.blob(), 'captions.' + format);
    return format === 'ass' ? copy.assDone : copy.done;
  } catch {
    return copy.network;
  }
}
