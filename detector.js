// 钢琴听音核心：起音检测 + 音高判断（单音/八度齐奏）
// 浏览器里挂在 window.PianoDetector，Node 里通过 module.exports 测试
(function (root) {
  'use strict';

  // ---------- FFT（基 2，原地） ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // 从环形缓冲区取一段加窗做 FFT，返回幅度谱
  function spectrum(ring, ringMask, start, win, fftSize, out) {
    const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
    const len = win.length;
    for (let i = 0; i < len; i++) re[i] = ring[(start + i) & ringMask] * win[i];
    fft(re, im);
    const half = fftSize >> 1;
    const mag = out || new Float32Array(half);
    for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  // 新音的“谐波得分”：在起音前后的差分谱上，按钢琴泛音（略微拉伸）找峰
  function scoreNotes(diff, sr, fftSize, lo, hi) {
    const binHz = sr / fftSize;
    const maxHz = Math.min(5000, sr / 2 - 100);
    const peak = (hz, cents) => {
      const r = Math.pow(2, cents / 1200);
      let a = Math.floor(hz / r / binHz), b = Math.ceil(hz * r / binHz);
      const c = Math.round(hz / binHz);
      a = Math.min(a, c); b = Math.max(b, c);
      let m = 0;
      for (let i = Math.max(1, a); i <= b && i < diff.length; i++) if (diff[i] > m) m = diff[i];
      return m;
    };
    const scores = [];
    for (let midi = lo; midi <= hi; midi++) {
      const f0 = midiToFreq(midi);
      // 低音区泛音拉伸小、高音区大
      const B = midi < 48 ? 0.00015 : midi < 72 ? 0.0004 : 0.002;
      let s = 0, pen = 0, count = 0;
      for (let k = 1; k <= 12; k++) {
        const fk = k * f0 * Math.sqrt(1 + B * k * k);
        if (fk > maxHz) break;
        const w = 1 / Math.pow(k, 0.6);
        s += w * peak(fk, 35);
        // 半音位置有能量，说明真正的基音在下方八度
        const fh = (k - 0.5) * f0 * Math.sqrt(1 + B * (k - 0.5) * (k - 0.5));
        if (k > 1 || f0 > 60) pen += w * peak(fh, 30);
        count++;
      }
      if (count === 0) continue;
      scores.push({ midi, score: s - 0.6 * pen });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores;
  }

  // ---------- 实时跟踪器 ----------
  // push(样本) 后返回本次检测到的音：{ time, midi, candidates, level }
  class Tracker {
    constructor(sr, opts = {}) {
      this.sr = sr;
      this.lo = opts.lo || 21;   // A0
      this.hi = opts.hi || 108;  // C8
      this.sensitivity = opts.sensitivity ?? 0.5; // 0~1，越大越灵敏
      this.ringSize = 1 << 18;   // 约 5 秒
      this.ringMask = this.ringSize - 1;
      this.ring = new Float32Array(this.ringSize);
      this.n = 0;                // 已写入样本总数

      this.hop = 512;
      this.frame = 2048;
      this.frameWin = hann(this.frame);
      this.nextFrameAt = this.frame;
      this.prevLog = null;
      this.fluxHist = [];
      this.fluxLast = [0, 0];    // flux[t-2], flux[t-1]
      this.rmsLast = [0, 0];
      this.lastOnset = -1e9;
      this.noiseRms = 0.002;

      // 音高分析窗：约 85 毫秒
      this.win = sr > 60000 ? 8192 : 4096;
      this.pitchWin = hann(this.win);
      this.pitchFft = this.win * 2;
      this.gap = Math.round(0.012 * sr);
      this.pending = [];
      this.level = 0;
    }

    push(samples) {
      const events = [];
      for (let i = 0; i < samples.length; i++) {
        this.ring[(this.n + i) & this.ringMask] = samples[i];
      }
      this.n += samples.length;

      while (this.n >= this.nextFrameAt) {
        this._onsetFrame(this.nextFrameAt - this.frame);
        this.nextFrameAt += this.hop;
      }
      while (this.pending.length && this.n >= this.pending[0] + this.gap + this.win) {
        const ev = this._analyze(this.pending.shift());
        if (ev) events.push(ev);
      }
      return events;
    }

    _onsetFrame(start) {
      const mag = spectrum(this.ring, this.ringMask, start, this.frameWin, this.frame);
      let rms = 0;
      for (let i = 0; i < this.frame; i++) {
        const v = this.ring[(start + i) & this.ringMask];
        rms += v * v;
      }
      rms = Math.sqrt(rms / this.frame);
      this.level = rms;

      const binHz = this.sr / this.frame;
      const b0 = Math.floor(25 / binHz), b1 = Math.min(mag.length, Math.ceil(6000 / binHz));
      const logm = new Float32Array(b1);
      for (let i = b0; i < b1; i++) logm[i] = Math.log(1 + 1000 * mag[i]);
      let flux = 0;
      if (this.prevLog) {
        for (let i = b0; i < b1; i++) {
          const d = logm[i] - this.prevLog[i];
          if (d > 0) flux += d;
        }
      }
      this.prevLog = logm;

      // 安静时慢慢跟踪环境噪声
      if (rms < this.noiseRms * 2) this.noiseRms = 0.98 * this.noiseRms + 0.02 * rms;

      // 峰值检测：flux[t-1] 是局部最大且超过自适应阈值
      const [f2, f1] = this.fluxLast;
      const hist = this.fluxHist;
      const sorted = hist.slice().sort((a, b) => a - b);
      const med = sorted.length ? sorted[sorted.length >> 1] : 0;
      const k = 2.4 - 1.4 * this.sensitivity;      // 灵敏度 → 阈值倍数
      const floor = (b1 - b0) * (0.06 - 0.04 * this.sensitivity);
      const thr = med * k + floor;
      const center = start - this.hop + this.frame / 2; // 上一帧的中心
      const minGap = 0.07 * this.sr;
      if (f1 > thr && f1 > f2 && f1 >= flux &&
          center - this.lastOnset > minGap &&
          Math.max(this.rmsLast[1], rms) > this.noiseRms * 4) {
        this.lastOnset = center;
        // 起音点大致在上一帧中心之前一点
        this.pending.push(Math.round(center - this.hop / 2));
      }
      this.fluxLast = [f1, flux];
      this.rmsLast = [this.rmsLast[1], rms];
      hist.push(flux);
      if (hist.length > 30) hist.shift();
    }

    _analyze(onset) {
      if (onset - this.gap - this.win < this.n - this.ringSize) return null;
      const post = spectrum(this.ring, this.ringMask, onset + this.gap, this.pitchWin, this.pitchFft);
      const pre = spectrum(this.ring, this.ringMask, onset - this.gap - this.win, this.pitchWin, this.pitchFft);
      let energy = 0;
      for (let i = 0; i < post.length; i++) {
        const d = post[i] - pre[i];
        post[i] = d > 0 ? d : 0;
        energy += post[i];
      }
      if (energy <= 0) return null;
      const cands = scoreNotes(post, this.sr, this.pitchFft, this.lo, this.hi);
      if (!cands.length || cands[0].score <= 0) return null;
      const top = cands[0].score;
      return {
        time: onset / this.sr,
        midi: cands[0].midi,
        // 分数相对最高分的比例，用来容忍八度判断误差
        candidates: cands.slice(0, 6).map((c) => ({ midi: c.midi, rel: c.score / top })),
      };
    }
  }

  const api = { Tracker, midiToFreq, fft, hann };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PianoDetector = api;
})(typeof self !== 'undefined' ? self : this);
