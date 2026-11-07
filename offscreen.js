/* Queued for ChatGPT v1.2.10 — bounded, low-allocation original notification tones. */
(() => {
  'use strict';
  const PATTERNS = Object.freeze({
    soft: { period: 0.90, notes: [[0, 587, 0.16], [0.19, 784, 0.24]] },
    double: { period: 0.88, notes: [[0, 659, 0.13], [0.23, 880, 0.18]] },
    alert: { period: 0.93, notes: [[0, 740, 0.12], [0.20, 740, 0.12], [0.40, 740, 0.12]] }
  });
  let active = null;
  function validDuration(value) {
    return value === 'once' || (typeof value === 'string' && /^(?:[1-9]|[1-5][0-9]|60)$/.test(value));
  }
  function validVolume(value) {
    return Number.isInteger(value) && value >= 0 && value <= 100;
  }
  function stopAudio() {
    const old = active;
    active = null;
    if (!old) return;
    clearTimeout(old.timer);
    for (const oscillator of old.oscillators) {
      try { oscillator.stop(); } catch (_) { /* Already stopped. */ }
      try { oscillator.disconnect(); } catch (_) {}
    }
    for (const gain of old.gains) {
      try { gain.disconnect(); } catch (_) {}
    }
    void old.context.close().catch(() => {});
  }
  function playAudio(sound, duration, volume) {
    if (!Object.prototype.hasOwnProperty.call(PATTERNS, sound) ||
        !validDuration(duration) || !validVolume(volume) || volume === 0) return false;
    stopAudio(); // One active player across all previews and run alerts.
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return false;
    let context = null;
    const oscillators = [], gains = [];
    try {
      context = new Audio();
      const pattern = PATTERNS[sound];
      const seconds = duration === 'once'
        ? Math.max(...pattern.notes.map(note => note[0] + note[2])) + 0.06
        : Number(duration);
      const beginning = context.currentTime + 0.04;
      const peak = (sound === 'alert' ? 0.15 : 0.20) * (volume / 100);
      // Every tone has one oscillator + gain per distinct frequency (1 or 2),
      // independent of the number of repetitions or selected duration.
      const byPitch = new Map();
      for (const [, pitch] of pattern.notes) {
        if (byPitch.has(pitch)) continue;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = sound === 'alert' ? 'triangle' : 'sine';
        oscillator.frequency.setValueAtTime(pitch, beginning);
        gain.gain.setValueAtTime(0.0001, beginning);
        oscillator.connect(gain);
        gain.connect(context.destination);
        byPitch.set(pitch, gain);
        oscillators.push(oscillator);
        gains.push(gain);
      }
      for (let offset = 0; offset < seconds; offset += pattern.period) {
        for (const [start, pitch, length] of pattern.notes) {
          const absolute = offset + start;
          if (absolute + length > seconds) continue;
          const at = beginning + absolute;
          const envelope = byPitch.get(pitch).gain;
          envelope.setValueAtTime(0.0001, at);
          envelope.linearRampToValueAtTime(peak, at + 0.018);
          envelope.exponentialRampToValueAtTime(0.0001, at + length);
        }
        if (duration === 'once') break;
      }
      for (const oscillator of oscillators) {
        oscillator.start(beginning);
        oscillator.stop(beginning + seconds + 0.01);
      }
      // One bounded cleanup timer; no recurring scheduler while sound is playing.
      const timer = setTimeout(stopAudio, Math.ceil((seconds + 0.04) * 1000) + 150);
      active = { context, oscillators, gains, timer };
      void Promise.resolve(context.resume()).catch(() => {
        if (active?.context === context) stopAudio();
      });
      // This acknowledges scheduling, not device audibility.
      return true;
    } catch (_) {
      if (active?.context === context) {
        stopAudio(); // Covers synchronous resume failures after timer creation.
        return false;
      }
      for (const oscillator of oscillators) {
        try { oscillator.stop(); } catch (_) {}
        try { oscillator.disconnect(); } catch (_) {}
      }
      for (const gain of gains) {
        try { gain.disconnect(); } catch (_) {}
      }
      if (context) void context.close().catch(() => {});
      return false;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.app !== 'qfc-audio-v1' || sender?.id !== chrome.runtime.id) return false;
    if (message.action === 'stop') {
      stopAudio();
      sendResponse({ stopped: true });
      return false;
    }
    if (message.action !== 'play') return false;
    sendResponse({ played: playAudio(message.sound, message.duration, message.volume) });
    return false;
  });
  window.addEventListener('pagehide', stopAudio);
})();
