#include "moonlight_wasm.hpp"

#include <chrono>
#include <cstdint>

#include "audio_pipeline_diagnostics.hpp"
#include "audio_sync.hpp"
#include "samsung/wasm/elementary_media_packet.h"

using std::chrono_literals::operator""s;
using TimeStamp = samsung::wasm::Seconds;

#define MAX_CHANNEL_COUNT 8
#define FRAME_SIZE 240

static constexpr double kAudioSoftHighWatermarkSeconds = 0.200;
static constexpr double kAudioSoftLowWatermarkSeconds = 0.120;
static constexpr double kAudioHardWatermarkSeconds = 0.350;
static constexpr std::size_t kAudioSoftDropInterval = 10;

static std::vector<opus_int16> s_DecodeBuffer;

static TimeStamp s_frameDuration;
static TimeStamp s_pktPts;

static size_t s_samplesPerFrame;
static size_t s_channelCount;

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

int MoonlightInstance::AudDecInit(int audioConfiguration, POPUS_MULTISTREAM_CONFIGURATION opusConfig, void* context, int arFlags) {
  int rc;

  ClLogMessage("MoonlightInstance::AudDecInit\n");

  // Initialize packet timestamp to zero
  s_pktPts = 0s;

  // Initialize samples per frame (240) and channels count (2, 6, 8)
  s_samplesPerFrame = opusConfig->samplesPerFrame;
  s_channelCount = opusConfig->channelCount;

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

  // Clear the decode buffer
  s_DecodeBuffer.clear();

  // Shrink the decode buffer to fit its contents
  s_DecodeBuffer.shrink_to_fit();
}

void MoonlightInstance::AudDecDecodeAndPlaySample(char* sampleData, int sampleLength) {
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

AUDIO_RENDERER_CALLBACKS MoonlightInstance::s_ArCallbacks = {
  .init = MoonlightInstance::AudDecInit,
  .cleanup = MoonlightInstance::AudDecCleanup,
  .decodeAndPlaySample = MoonlightInstance::AudDecDecodeAndPlaySample,
  .capabilities = CAPABILITY_DIRECT_SUBMIT,
};
