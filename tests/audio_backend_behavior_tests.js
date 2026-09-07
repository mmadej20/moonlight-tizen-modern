'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const contexts = [];
class AudioContextStub {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 1;
    this.state = 'running';
    this.baseLatency = 0;
    this.destination = { maxChannelCount: 8 };
    this.starts = [];
    contexts.push(this);
  }
  createBuffer(channels, samples, rate) {
    const data = Array.from({ length: channels }, () => new Float32Array(samples));
    return { duration: samples / rate, getChannelData: channel => data[channel] };
  }
  createBufferSource() {
    return { connect() {}, start: time => this.starts.push(time) };
  }
  close() { this.state = 'closed'; return Promise.resolve(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}
const context = {
  console: { log() {}, warn() {}, error() {} },
  Module: { HEAPF32: new Float32Array(480 * 8) },
  AudioContext: AudioContextStub,
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync('wasm/platform/audio.js', 'utf8'), context);

context.startAudioScheduler();
const oldGeneration = context._audGeneration;
context._mlAudioTargetMs = 150;
context._audReceiveFrame(0, 240, 2, 48000, 480, 0, oldGeneration);
assert.strictEqual(contexts[0].starts[0], 1.15, 'honor selected jitter target');
context.stopAudioScheduler();
assert.strictEqual(contexts[0].state, 'closed');
context._audReceiveFrame(0, 240, 2, 48000, 480, 1, oldGeneration);
assert.strictEqual(contexts[0].starts.length, 1, 'do not play after stop');

context.startAudioScheduler();
const nextGeneration = context._audGeneration;
context._audReceiveFrame(0, 240, 2, 48000, 480, 2, oldGeneration);
assert.strictEqual(contexts[1].starts.length, 0, 'queued old session frame must not enter new session');
context.stopAudioScheduler(oldGeneration);
assert.strictEqual(contexts[1].state, 'running', 'old native cleanup must not close new context');
context._audSetTargetMs(250, oldGeneration);
assert.notStrictEqual(context._mlAudioTargetMs, 250, 'old target callback must be ignored');
context._audSetTargetMs(100, nextGeneration);
context._audReceiveFrame(0, 480, 2, 48000, 480, 0, nextGeneration);
assert.strictEqual(contexts[1].starts[0], 1.1, 'new session still renders 10 ms frames');
context.stopAudioScheduler(nextGeneration);
assert.strictEqual(contexts[1].state, 'closed');
console.log('audio_backend_behavior_tests: PASS');
