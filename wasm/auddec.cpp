#include "moonlight_wasm.hpp"

#include <chrono>
#include <cstdint>

#include "audio_pipeline_diagnostics.hpp"
#include "audio_sync.hpp"
#include "web_audio_decode.hpp"
#include <emscripten.h>

#include "samsung/wasm/elementary_media_packet.h"

using std::chrono_literals::operator""s;
using TimeStamp = samsung::wasm::Seconds;

#define MAX_CHANNEL_COUNT 8
#define FRAME_SIZE 240

static constexpr double kAudioSoftHighWatermarkSeconds = 0.200;
static constexpr double kAudioSoftLowWatermarkSeconds = 0.120;
static constexpr double kAudioHardWatermarkSeconds = 0.350;
static constexpr std::size_t kAudioSoftDropInterval = 10;

// Number of decoded frames kept in the Web Audio slot pool. Frames are handed to the main
// thread by pointer, so a slot must stay untouched long enough for the scheduler to read it.
// The pool covers well over a second of audio, because a slot that is overwritten before the
// main thread got to it is played as the audio of a later frame rather than being skipped.
static constexpr int kAudioSlotCount = 128;

// Largest number of samples per channel the Web Audio slot pool can hold. The RTSP negotiation
// never asks for more than 10 ms of audio per packet, which is 480 samples at 48 kHz. This is
// also the distance between the channels of a frame, as the samples are stored per channel.
static constexpr size_t kAudioSlotStride = 480;

// Largest decoded frame the Web Audio slot pool can hold, over all of the possible channels
static constexpr size_t kAudioSlotElements = kAudioSlotStride * MAX_CHANNEL_COUNT;

// Jitter buffer target used by the Web Audio backend when the user has not selected one
static constexpr int kDefaultAudioJitterMs = 100;

static std::vector<opus_int16> s_DecodeBuffer;

static TimeStamp s_frameDuration;
static TimeStamp s_pktPts;

static size_t s_samplesPerFrame;
static size_t s_channelCount;
static int s_sampleRate;

static std::chrono::time_point<std::chrono::steady_clock> s_firstAppend;

static bool s_hasFirstFrame = false;
static bool s_AudioSyncEnabled = false;

static AudioSyncController s_AudioSyncController(
  kAudioSoftHighWatermarkSeconds,
  kAudioSoftLowWatermarkSeconds,
  kAudioHardWatermarkSeconds,
  kAudioSoftDropInterval
);
static AudioPipelineDiagnostics s_AudioPipelineDiagnostics;

struct DecodeAppendResult {
  AudioPacketOutcome outcome;
  std::uint64_t decodeUs;
  std::uint64_t appendUs;
  int appendResultCode;
};

// Audio backend rendering the stream, latched when the audio stream is initialized so that
// the decoding callbacks cannot observe a backend change made while a stream is running
static AudioBackend s_AudioBackend = AudioBackend::Emss;
static int s_WebAudioGeneration = 0;

// Rotating pool of decoded frames for the Web Audio backend. This is statically allocated
// because the scheduler on the main thread reads a slot asynchronously, so the memory must
// stay valid for the lifetime of the application rather than that of a streaming session.
//
// The samples are stored per channel and already scaled to the -1.0 to 1.0 range that the Web
// Audio API expects, so the main thread only has to copy them into an audio buffer. Converting
// them here keeps that work on the audio thread, which is the one thread that Game Mode does
// not load with the video packets that are submitted to the elementary media pipeline.
static float s_AudioSlots[kAudioSlotCount][kAudioSlotElements];
static int s_AudioSlotIndex = 0;

// Interleaved samples of the frame that is being decoded, before it is split per channel
static opus_int16 s_AudioPcm[kAudioSlotElements];

// Index of the next frame handed to the scheduler, which reports the frames that never made
// it to the main thread as gaps in its statistics
static int s_AudioSequence = 0;

// Frames the Opus decoder rejected since the last time it was reported
static int s_AudioDecodeErrors = 0;

static inline TimeStamp FrameDuration(double samplesPerFrame, double sampleRate) {
  // Calculate the duration of a frame based on the number of samples per frame and the sample rate
  return TimeStamp(samplesPerFrame / sampleRate);
}

static std::uint64_t SteadyNowUs() {
  return static_cast<std::uint64_t>(
    std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()
    ).count()
  );
}

static std::uint64_t ElapsedUs(
  std::chrono::time_point<std::chrono::steady_clock> start,
  std::chrono::time_point<std::chrono::steady_clock> end
) {
  return static_cast<std::uint64_t>(
    std::chrono::duration_cast<std::chrono::microseconds>(end - start).count()
  );
}

static void LogAudioPipelineSnapshot(
  const std::optional<AudioPipelineSnapshot>& snapshot
) {
  if (!snapshot) {
    return;
  }

  MoonlightInstance::ClLogMessage(
    "AudioPipelineStats windowMs=%llu packets=%llu appended=%llu plc=%llu "
    "softDrop=%llu hardDrop=%llu decodeFail=%llu appendIgnored=%llu "
    "appendBufferFull=%llu appendOther=%llu decodeAvgUs=%llu "
    "decodeMaxUs=%llu appendAvgUs=%llu appendMaxUs=%llu "
    "callbackAvgUs=%llu callbackMaxUs=%llu mediaOffsetMs=%.3f "
    "mediaOffsetMaxMs=%.3f leadMaxMs=%.3f session=%d "
    "lastAppendResult=%d\n",
    static_cast<unsigned long long>(snapshot->windowUs / 1000),
    static_cast<unsigned long long>(snapshot->packets),
    static_cast<unsigned long long>(snapshot->appended),
    static_cast<unsigned long long>(snapshot->plc),
    static_cast<unsigned long long>(snapshot->softDropped),
    static_cast<unsigned long long>(snapshot->hardDropped),
    static_cast<unsigned long long>(snapshot->decodeFailed),
    static_cast<unsigned long long>(snapshot->appendIgnored),
    static_cast<unsigned long long>(snapshot->appendBufferFull),
    static_cast<unsigned long long>(snapshot->appendOtherFailure),
    static_cast<unsigned long long>(snapshot->decodeAvgUs),
    static_cast<unsigned long long>(snapshot->decodeMaxUs),
    static_cast<unsigned long long>(snapshot->appendAvgUs),
    static_cast<unsigned long long>(snapshot->appendMaxUs),
    static_cast<unsigned long long>(snapshot->callbackAvgUs),
    static_cast<unsigned long long>(snapshot->callbackMaxUs),
    snapshot->mediaOffsetSeconds * 1000.0,
    snapshot->mediaOffsetMaxSeconds * 1000.0,
    snapshot->syncLeadMaxSeconds * 1000.0,
    snapshot->sessionId,
    snapshot->lastAppendResultCode
  );
}

static DecodeAppendResult DecodeAndAppendPacket(
  samsung::wasm::ElementaryMediaTrack* track,
  samsung::wasm::SessionId session_id,
  OpusMSDecoder* decoder, const unsigned char* sampleData, int sampleLength) {
  const auto decodeStart = std::chrono::steady_clock::now();

  // Decode the incoming audio packet using Opus decoder
  const int decodeLen = opus_multistream_decode(
    decoder, sampleData, sampleLength,
    s_DecodeBuffer.data(), s_samplesPerFrame, 0
  );
  const auto decodeEnd = std::chrono::steady_clock::now();
  const auto decodeUs = ElapsedUs(decodeStart, decodeEnd);

  // Check if audio decoding failed
  if (decodeLen <= 0) {
    // Reset the buffer contents to zero when decoding fails
    s_DecodeBuffer.assign(s_DecodeBuffer.size(), 0);
    return {
      AudioPacketOutcome::DecodeFailed,
      decodeUs,
      0,
      0,
    };
  }

  // Calculate desired buffer size in bytes for decoded audio data
  size_t s_desiredBufferSize = sizeof(opus_int16) * decodeLen * s_channelCount;

  // Create an ElementaryMediaPacket and start decoding with the decoded audio data
  samsung::wasm::ElementaryMediaPacket pkt {
    s_pktPts, // presentation timestamp
    s_pktPts, // decoding timestamp
    s_frameDuration, // packet duration
    true, // bool value indicating if packet is a keyframe
    s_desiredBufferSize, // packet size
    s_DecodeBuffer.data(), // pointer to packet payload
    0, 0, 0, 1, // packet of width, height, framerate numerator and framerate denominator
    session_id // session identifier
  };

  // Attempt to append the packet to the audio track for rendering
  const auto appendStart = std::chrono::steady_clock::now();
  const auto appendResult = track->AppendPacket(pkt);
  const auto appendEnd = std::chrono::steady_clock::now();
  const auto appendUs = ElapsedUs(appendStart, appendEnd);
  const auto appendResultCode =
    static_cast<int>(appendResult.operation_result);

  AudioPacketOutcome outcome;
  if (appendResult) {
    // If successful, update the presentation timestamp for the next packet
    s_pktPts += s_frameDuration;
    outcome = AudioPacketOutcome::Appended;
  } else if (
    appendResult.operation_result ==
    samsung::wasm::OperationResult::kAppendIgnored
  ) {
    outcome = AudioPacketOutcome::AppendIgnored;
  } else if (
    appendResult.operation_result ==
    samsung::wasm::OperationResult::kAppendBufferFull
  ) {
    outcome = AudioPacketOutcome::AppendBufferFull;
  } else {
    outcome = AudioPacketOutcome::AppendOtherFailure;
  }

  if (outcome != AudioPacketOutcome::Appended) {
    return {
      outcome,
      decodeUs,
      appendUs,
      appendResultCode,
    };
  }

  // Resize decode buffer if it's smaller than the desired size
  if (s_desiredBufferSize > s_DecodeBuffer.size()) {
    s_DecodeBuffer.resize(s_desiredBufferSize);
  }

  return {
    outcome,
    decodeUs,
    appendUs,
    appendResultCode,
  };
}

static void DecodeAndScheduleFrame(OpusMSDecoder* decoder, const unsigned char* sampleData, int sampleLength) {
  // Check if the Opus decoder failed to be created for this streaming session
  if (!decoder) {
    return;
  }

  // Decode the incoming audio packet using Opus decoder. The whole slot is offered to the
  // decoder rather than the negotiated frame size, so a packet that carries more audio than
  // the RTSP negotiation announced is still decoded instead of being rejected.
  int decodeLen = DecodeWebAudioPacket(
    decoder, sampleData, sampleLength,
    s_AudioPcm, static_cast<int>(s_samplesPerFrame), kAudioSlotStride
  );

  // Check if audio decoding failed
  if (decodeLen <= 0) {
    // Report the rejected packets in batches, as logging every one of them from the audio
    // thread would cost more time than decoding them
    if (++s_AudioDecodeErrors % 100 == 1) {
      MoonlightInstance::ClLogMessage("The Opus decoder rejected %d audio packets, last with error %d\n",
        s_AudioDecodeErrors, decodeLen);
    }
    return;
  }

  // Take the next slot of the pool so the scheduler still has time to read the previous ones
  float* slot = s_AudioSlots[s_AudioSlotIndex];

  // Split the interleaved samples per channel and scale them to the -1.0 to 1.0 range that
  // the Web Audio API expects, so the main thread only has to copy them out of the heap
  for (size_t channel = 0; channel < s_channelCount; channel++) {
    float* output = slot + channel * kAudioSlotStride;
    for (int sample = 0; sample < decodeLen; sample++) {
      output[sample] = s_AudioPcm[sample * s_channelCount + channel] / 32768.0f;
    }
  }

  // Advance to the next slot only once a frame was written, so a failed decode does not
  // consume the protection window that the already scheduled frames rely on
  s_AudioSlotIndex = (s_AudioSlotIndex + 1) % kAudioSlotCount;

  // Number this frame so the scheduler can report the ones that never reached the main thread
  int sequence = s_AudioSequence++;

  // Hand the decoded samples to the audio scheduler running on the main thread. This is
  // asynchronous, so the audio thread is never blocked waiting on the browser event loop.
  MAIN_THREAD_ASYNC_EM_ASM({
    if (typeof _audReceiveFrame === 'function') {
      _audReceiveFrame($0, $1, $2, $3, $4, $5, $6);
    }
  }, (int)(size_t)slot, decodeLen, (int)s_channelCount, s_sampleRate,
     (int)kAudioSlotStride, sequence, s_WebAudioGeneration);
}

int MoonlightInstance::AudDecInit(int audioConfiguration, POPUS_MULTISTREAM_CONFIGURATION opusConfig, void* context, int arFlags) {
  int rc;

  ClLogMessage("MoonlightInstance::AudDecInit\n");

  // Latch the audio backend selected for this streaming session
  s_AudioBackend = g_Instance->m_AudioBackend;
  s_WebAudioGeneration = g_Instance->m_WebAudioGeneration;

  // Skip creating the Opus decoder when the audio output is disabled, as every audio packet is discarded
  if (s_AudioBackend == AudioBackend::Disabled) {
    ClLogMessage("Audio output is disabled, so the audio stream will be discarded\n");
    return 0;
  }

  // Initialize packet timestamp to zero
  s_pktPts = 0s;

  // Initialize samples per frame (240 or 480), channels count (2, 6, 8) and sample rate (48000)
  s_samplesPerFrame = opusConfig->samplesPerFrame;
  s_channelCount = opusConfig->channelCount;
  s_sampleRate = opusConfig->sampleRate;

  // Calculate buffer size in bytes for one decoded audio frame
  size_t s_bufferSize = sizeof(opus_int16) * s_samplesPerFrame * s_channelCount;

  // Resize the decode buffer based on the samples per frame and channels count
  s_DecodeBuffer.resize(s_bufferSize);

  // Calculate the frame duration based on the samples per frame (240) and sample rate (48000)
  s_frameDuration = FrameDuration(opusConfig->samplesPerFrame, opusConfig->sampleRate);

  if (g_Instance->m_OpusDecoder) {
    opus_multistream_decoder_destroy(g_Instance->m_OpusDecoder);
    g_Instance->m_OpusDecoder = nullptr;
  }

  // Create the Opus decoder with the provided configuration parameters
  g_Instance->m_OpusDecoder = opus_multistream_decoder_create(
    opusConfig->sampleRate, opusConfig->channelCount,
    opusConfig->streams, opusConfig->coupledStreams,
    opusConfig->mapping, &rc
  );
  if (rc != OPUS_OK || !g_Instance->m_OpusDecoder) {
    if (g_Instance->m_OpusDecoder) {
      opus_multistream_decoder_destroy(g_Instance->m_OpusDecoder);
    }
    g_Instance->m_OpusDecoder = nullptr;
    return -1;
  }

  s_AudioSyncController.Reset();
  s_AudioPipelineDiagnostics.Reset(SteadyNowUs());

  // Flag indicating whether this is the first frame of audio to be decoded
  s_hasFirstFrame = false;

  // Set the audio synchronization flag based on instance configuration
  s_AudioSyncEnabled = g_Instance->m_AudioSyncEnabled;

  // Prepare the audio scheduler when the Web Audio backend is selected
  if (s_AudioBackend == AudioBackend::WebAudio) {
    // Refuse to stream audio that cannot fit in a slot of the pool, as writing a larger
    // frame would corrupt the neighboring slots that are waiting to be scheduled
    if (s_samplesPerFrame > kAudioSlotStride || s_channelCount > MAX_CHANNEL_COUNT) {
      ClLogMessage("Decoded audio frames of %d samples over %d channels are too large for the Web Audio backend!\n",
        (int)s_samplesPerFrame, (int)s_channelCount);
      return -1;
    }

    // Report the audio format the RTSP negotiation settled on, so that a packet duration other
    // than the expected one can be told apart from the scheduler falling behind
    ClLogMessage("Negotiated %d samples per frame over %d channels at %d Hz, which is %.1f ms of audio per packet\n",
      (int)s_samplesPerFrame, (int)s_channelCount, s_sampleRate, s_frameDuration.count() * 1000.0);

    // Start writing decoded frames at the beginning of the slot pool
    s_AudioSlotIndex = 0;
    s_AudioSequence = 0;
    s_AudioDecodeErrors = 0;

    // Select the jitter buffer target requested by the user, or the default one when unset
    int audioJitterMs = g_Instance->m_AudioJitterMs > 0 ? g_Instance->m_AudioJitterMs : kDefaultAudioJitterMs;
    ClLogMessage("Selected the Web Audio backend with a jitter buffer of %d ms\n", audioJitterMs);

    // Publish the jitter buffer target to the audio scheduler in platform/audio.js
    MAIN_THREAD_ASYNC_EM_ASM({
      if (typeof _audSetTargetMs === 'function') {
        _audSetTargetMs($0, $1);
      }
    }, audioJitterMs, s_WebAudioGeneration);
  } else {
    ClLogMessage("Selected the EMSS audio backend\n");
  }

  return 0;
}

void MoonlightInstance::AudDecCleanup(void) {
  LogAudioPipelineSnapshot(
    s_AudioPipelineDiagnostics.Flush(SteadyNowUs())
  );

  if (g_Instance->m_OpusDecoder) {
    opus_multistream_decoder_destroy(g_Instance->m_OpusDecoder);
    g_Instance->m_OpusDecoder = nullptr;
  }

  // Stop the audio scheduler so it does not keep playing frames that were decoded
  // before the streaming session ended
  if (s_AudioBackend == AudioBackend::WebAudio) {
    MAIN_THREAD_ASYNC_EM_ASM({
      if (typeof stopAudioScheduler === 'function') {
        stopAudioScheduler($0);
      }
    }, s_WebAudioGeneration);
  }

  // Clear the decode buffer
  s_DecodeBuffer.clear();

  // Shrink the decode buffer to fit its contents
  s_DecodeBuffer.shrink_to_fit();
}

void MoonlightInstance::AudDecDecodeAndPlaySample(char* sampleData, int sampleLength) {
  // Discard the audio packet without decoding it when the audio output is disabled
  if (s_AudioBackend == AudioBackend::Disabled) {
    return;
  }

  // Check if the Web Audio backend is rendering this streaming session
  if (s_AudioBackend == AudioBackend::WebAudio) {
    // Decode the audio packet and schedule it for playback on the main thread
    DecodeAndScheduleFrame(g_Instance->m_OpusDecoder,
      reinterpret_cast<unsigned char*>(sampleData), sampleLength
    );
    return;
  }

  const auto callbackStart = std::chrono::steady_clock::now();

  // Check if audio playback has not started
  if (!g_Instance->m_AudioStarted || !g_Instance->m_OpusDecoder) {
    return;
  }

  // Check if this is the first audio frame
  if (!s_hasFirstFrame) {
    // Record the time of the first frame
    s_firstAppend = callbackStart;
    s_AudioPipelineDiagnostics.Reset(SteadyNowUs());
    // Update the flag to indicate that the first frame has been processed
    s_hasFirstFrame = true;
  }

  // Get the current time and calculate the time elapsed since the first frame
  const auto now = callbackStart;
  TimeStamp ntp = now - s_firstAppend;
  const TimeStamp packetPts = s_pktPts;
  const auto sessionId = g_Instance->m_AudioSessionId.load();
  const bool plc = sampleData == nullptr || sampleLength == 0;

  if (s_AudioSyncEnabled) {
    const auto syncDecision = s_AudioSyncController.ObservePacket(ntp.count());
    if (syncDecision != AudioSyncDecision::Append) {
      const auto callbackEnd = std::chrono::steady_clock::now();
      LogAudioPipelineSnapshot(
        s_AudioPipelineDiagnostics.Record(
          {
            syncDecision == AudioSyncDecision::DropHard
              ? AudioPacketOutcome::HardDropped
              : AudioPacketOutcome::SoftDropped,
            plc,
            0,
            0,
            ElapsedUs(callbackStart, callbackEnd),
            ntp.count() - packetPts.count(),
            s_AudioSyncController.EstimatedLead(ntp.count()),
            static_cast<int>(sessionId),
            0,
          },
          SteadyNowUs()
        )
      );
      return;
    }
  }

  // Decode and append the audio packet to the audio track
  const auto decodeOutcome = DecodeAndAppendPacket(&g_Instance->m_AudioTrack,
    sessionId, g_Instance->m_OpusDecoder,
    reinterpret_cast<unsigned char*>(sampleData), sampleLength
  );

  if (decodeOutcome.outcome == AudioPacketOutcome::Appended) {
    s_AudioSyncController.CommitAppend(ntp.count(), s_frameDuration.count());
  }

  const auto callbackEnd = std::chrono::steady_clock::now();
  LogAudioPipelineSnapshot(
    s_AudioPipelineDiagnostics.Record(
      {
        decodeOutcome.outcome,
        plc,
        decodeOutcome.decodeUs,
        decodeOutcome.appendUs,
        ElapsedUs(callbackStart, callbackEnd),
        ntp.count() - packetPts.count(),
        s_AudioSyncController.EstimatedLead(ntp.count()),
        static_cast<int>(sessionId),
        decodeOutcome.appendResultCode,
      },
      SteadyNowUs()
    )
  );
}

// NOTE: The capabilities are updated before every connection in ConnectionThreadFunc, as the
// Web Audio backend also announces CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION. The value
// below is the one used by the EMSS backend, which is the default audio backend.
AUDIO_RENDERER_CALLBACKS MoonlightInstance::s_ArCallbacks = {
  .init = MoonlightInstance::AudDecInit,
  .cleanup = MoonlightInstance::AudDecCleanup,
  .decodeAndPlaySample = MoonlightInstance::AudDecDecodeAndPlaySample,
  .capabilities = CAPABILITY_DIRECT_SUBMIT,
};
