// Mic capture: float samples at the AudioContext rate → PCM16 mono frames of 20ms at targetRate.
// Downsampling uses box-filter averaging (cheap anti-aliasing, adequate for speech recognition).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetRate;
    this.ratio = sampleRate / this.targetRate;
    this.frameSamples = Math.round(this.targetRate * 0.02);
    this.out = new Int16Array(this.frameSamples);
    this.outIndex = 0;
    this.acc = 0;
    this.count = 0;
    this.phase = 0;
  }

  push(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.out[this.outIndex++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.outIndex === this.frameSamples) {
      const buffer = this.out.slice().buffer;
      this.port.postMessage(buffer, [buffer]);
      this.outIndex = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.ratio <= 1.0001) {
      for (let i = 0; i < channel.length; i++) this.push(channel[i]);
      return true;
    }
    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i];
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.push(this.acc / this.count);
        this.phase -= this.ratio;
        this.acc = 0;
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
