/* Queued for ChatGPT v1.2.9 — bounded original notification tones. */
(() => {
  'use strict';
  const PATTERNS = Object.freeze({
    soft: { period: 0.90, notes: [[0, 587, 0.16], [0.19, 784, 0.24]] },
    double: { period: 0.88, notes: [[0, 659, 0.13], [0.23, 880, 0.18]] },
    alert: { period: 0.93, notes: [[0, 740, 0.12], [0.20, 740, 0.12], [0.40, 740, 0.12]] }
  });
  let active = null;
  function stopAudio() {
    const old = active;
    active = null;
    if (!old) return;
    clearTimeout(old.timer);
    for (const oscillator of old.oscillators) {
      try { oscillator.stop(); } catch (_) { /* May have stopped already. */ }
      try { oscillator.disconnect(); } catch (_) {}
    }
    void old.context.close().catch(() => {});
  }
  function playAudio(sound, duration) {
    if (!Object.prototype.hasOwnProperty.call(PATTERNS, sound) ||
        !['once', '5', '10', '20'].includes(duration)) return false;
    stopAudio(); // Latest sound replaces the previous one; no overlapping alarms.
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return false;
    let context;
    try {
      context = new Audio();
      const oscillators = [];
      const pattern = PATTERNS[sound];
      const seconds = duration === 'once'
        ? Math.max(...pattern.notes.map(note => note[0] + note[2])) + 0.06
        : Number(duration);
      const beginning = context.currentTime + 0.04;
      for (let offset = 0; offset < seconds; offset += pattern.period) {
        for (const [start, pitch, length] of pattern.notes) {
          const absolute = offset + start;
          if (absolute + length > seconds) continue;
          const at = beginning + absolute;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = sound === 'alert' ? 'triangle' : 'sine';
          oscillator.frequency.setValueAtTime(pitch, at);
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.linearRampToValueAtTime(sound === 'alert' ? 0.027 : 0.040, at + 0.018);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(at);
          oscillator.stop(at + length + 0.01);
          oscillators.push(oscillator);
        }
        if (duration === 'once') break;
      }
      // Keep the timer inside the audio document, never the service worker.
      const timer = setTimeout(stopAudio, Math.ceil(seconds * 1000) + 150);
      active = { context, oscillators, timer };
      void context.resume().catch(() => {
        if (active?.context === context) stopAudio();
      });
      return true;
    } catch (_) {
      if (context) void context.close().catch(() => {});
      return false;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.app !== 'qfc-audio-v1' || message.action !== 'play' ||
        sender?.id !== chrome.runtime.id) return false;
    sendResponse({ played: playAudio(message.sound, message.duration) });
    return false;
  });
  window.addEventListener('pagehide', stopAudio);
})();
