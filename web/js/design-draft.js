// A recovered answer needs an explicit decision before voice auto-listening/sending.
export function designDraftNotice({ text = '', pending = false, mode = 'type' }) {
  const value = text.trim();
  return {
    visible: mode === 'voice' && pending && Boolean(value),
    tail: value.slice(-160),
    blocksMic: pending && Boolean(value),
  };
}
