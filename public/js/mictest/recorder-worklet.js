// AudioWorklet for the mic test page: copies the microphone's samples for a given range of the
// context's frames and posts them back, so a click scheduled at frame F can be looked for in the
// recording. `currentFrame` is the context frame of the first sample of each 128-frame block.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.jobs = [];
    this.port.onmessage = (e) => {
      const { id, from, frames } = e.data || {};
      if (Number.isFinite(from) && frames > 0) this.jobs.push({ id, from, frames, buf: new Float32Array(frames) });
    };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (this.jobs.length) {
      const blockStart = currentFrame;
      for (const job of this.jobs) {
        if (!ch) continue;
        const from = Math.max(job.from, blockStart);
        const to = Math.min(job.from + job.frames, blockStart + ch.length);
        for (let f = from; f < to; f++) job.buf[f - job.from] = ch[f - blockStart];
      }
      const end = blockStart + 128;
      this.jobs = this.jobs.filter((job) => {
        if (end < job.from + job.frames) return true;
        this.port.postMessage({ id: job.id, samples: job.buf }, [job.buf.buffer]);
        return false;
      });
    }
    return true;
  }
}

registerProcessor('ok-recorder', RecorderProcessor);
