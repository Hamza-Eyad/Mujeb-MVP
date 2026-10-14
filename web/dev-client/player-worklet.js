// Playback: an ordered queue of PCM16 audio items and marks, tagged with an epoch.
// - Marks are acknowledged when playback reaches them (what was actually played).
// - `clear` drops everything for that epoch and older, and ignores late frames from it.
// - `pause`/`resume` hold the queue without discarding it (soft barge-in).
class PlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.step = options.processorOptions.inputRate / sampleRate;
    this.queue = [];
    this.pos = 0;
    this.paused = false;
    this.minEpoch = 0;
    this.playingEpoch = -1;
    this.idle = true;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(msg) {
    if (msg.type === 'audio') {
      if (msg.epoch < this.minEpoch) return; // stale audio from an interrupted turn
      this.queue.push({ type: 'audio', epoch: msg.epoch, data: new Int16Array(msg.buffer) });
    } else if (msg.type === 'mark') {
      if (msg.epoch < this.minEpoch) return;
      this.queue.push({ type: 'mark', epoch: msg.epoch, name: msg.name });
    } else if (msg.type === 'clear') {
      this.minEpoch = Math.max(this.minEpoch, msg.epoch + 1);
      this.queue = this.queue.filter((item) => item.epoch >= this.minEpoch);
      this.pos = 0;
      this.paused = false;
      this.port.postMessage({ type: 'cleared', epoch: msg.epoch });
    } else if (msg.type === 'pause') {
      this.paused = true;
    } else if (msg.type === 'resume') {
      this.paused = false;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const out = output[0];
    for (let i = 0; i < out.length; i++) {
      if (this.paused) {
        out[i] = 0;
        continue;
      }
      while (this.queue.length > 0 && this.queue[0].type === 'mark') {
        this.port.postMessage({ type: 'mark', name: this.queue.shift().name });
      }
      const item = this.queue[0];
      if (!item) {
        out[i] = 0;
        if (!this.idle) {
          this.idle = true;
          this.port.postMessage({ type: 'idle' });
        }
        continue;
      }
      if (item.epoch !== this.playingEpoch) {
        this.playingEpoch = item.epoch;
        this.port.postMessage({ type: 'started', epoch: item.epoch });
      }
      this.idle = false;
      const idx = Math.floor(this.pos);
      const frac = this.pos - idx;
      const s0 = item.data[idx];
      const s1 = idx + 1 < item.data.length ? item.data[idx + 1] : s0;
      out[i] = (s0 + (s1 - s0) * frac) / 32768;
      this.pos += this.step;
      if (this.pos >= item.data.length) {
        this.pos -= item.data.length;
        this.queue.shift();
      }
    }
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor('player-processor', PlayerProcessor);
