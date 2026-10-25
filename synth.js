// 简易钢琴音色合成：用来离线测试识别算法，也用于页面的“演示”按钮
// notes: [{ midi, t, dur, vel }]，pedal=true 时松键不止音
(function (root) {
  'use strict';

  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  function render(notes, sr, opts = {}) {
    const rand = rng(opts.seed || 7);
    const end = Math.max(...notes.map((n) => n.t + n.dur)) + 1.0;
    const out = new Float32Array(Math.ceil(end * sr));
    for (const n of notes) {
      const f0 = 440 * Math.pow(2, (n.midi - 69) / 12);
      const vel = n.vel ?? 0.7;
      const B = n.midi < 48 ? 0.0002 : n.midi < 72 ? 0.0006 : 0.003;
      const start = Math.round(n.t * sr);
      const release = opts.pedal ? Infinity : n.t + n.dur;
      const stop = Math.min(out.length, start + Math.round((opts.pedal ? 4 : n.dur + 0.4) * sr));
      for (let k = 1; k <= 40; k++) {
        const fk = k * f0 * Math.sqrt(1 + B * k * k);
        if (fk > Math.min(9000, sr / 2 - 200)) break;
        let a = vel / Math.pow(k, 1.1) * (0.6 + 0.8 * rand());
        if (n.midi < 45 && k === 1) a *= 0.25;
        if (n.midi < 45 && k === 2) a *= 0.6;
        const tau = Math.max(0.15, (3.2 - (n.midi - 21) / 30)) / (1 + 0.35 * k);
        const ph = rand() * 2 * Math.PI;
        const w = 2 * Math.PI * fk / sr;
        for (let i = start; i < stop; i++) {
          const t = (i - start) / sr;
          const abs = i / sr;
          let env = Math.exp(-t / tau) * Math.min(1, t / 0.002);
          if (abs > release) env *= Math.exp(-(abs - release) / 0.06);
          out[i] += a * env * Math.sin(w * (i - start) + ph);
        }
      }
      // 击弦噪声
      for (let i = start; i < Math.min(out.length, start + Math.round(0.02 * sr)); i++) {
        const t = (i - start) / sr;
        out[i] += vel * 0.08 * (rand() * 2 - 1) * Math.exp(-t / 0.004);
      }
    }
    // 模拟房间混响（几个衰减回声）和笔记本麦克风的低频衰减
    if (opts.room !== false) {
      const taps = [[0.023, 0.25], [0.041, 0.18], [0.067, 0.12], [0.11, 0.07]];
      const src = out.slice();
      for (const [d, g] of taps) {
        const off = Math.round(d * sr);
        for (let i = off; i < out.length; i++) out[i] += g * src[i - off];
      }
    }
    const hp = opts.lowCut ?? 120;
    if (hp > 0) {
      const rc = 1 / (2 * Math.PI * hp), dt = 1 / sr, alpha = rc / (rc + dt);
      let px = 0, py = 0;
      for (let i = 0; i < out.length; i++) {
        const y = alpha * (py + out[i] - px);
        px = out[i]; py = y; out[i] = y;
      }
    }
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const gain = (opts.gain ?? 0.3) / (peak || 1);
    const noise = opts.noise ?? 0.002;
    for (let i = 0; i < out.length; i++) out[i] = out[i] * gain + noise * (rand() * 2 - 1);
    return out;
  }

  const api = { render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PianoSynth = api;
})(typeof self !== 'undefined' ? self : this);
