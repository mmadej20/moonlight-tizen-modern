#include "moonlight_wasm.hpp"

#include <chrono>
#include <cstdint>

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
static std::chrono::time_point<std::chrono::steady_clock> s_lastAudioSyncLog;

static bool s_hasFirstFrame = false;
static bool s_AudioSyncEnabled = false;

static AudioSyncController s_AudioSyncController(
  kAudioSoftHighWatermarkSeconds,
  kAudioSoftLowWatermarkSeconds,
  kAudioHardWatermarkSeconds,
  kAudioSoftDropInterval
);
static std::uint64_t s_audioSyncDroppedPackets = 0;
static std::uint64_t s_audioSyncHardDrops = 0;
static double s_audioSyncMaxLeadSeconds = 0.0;

enum class DecodeAppendOutcome {
  DecodeFailed,
  AppendFailed,
  Appended,
};

static inline TimeStamp FrameDuration(double samplesPerFrame, double sampleRate) {
  // Calculate the duration of a frame based on the number of samples per frame and the sample rate
  return TimeStamp(samplesPerFrame / sampleRate);
}

static void MaybeLogAudioSyncCorrection(
  std::chrono::time_point<std::chrono::steady_clock> now
) {
  if (s_audioSyncDroppedPackets == 0 ||
      now - s_lastAudioSyncLog < std::chrono::seconds(1)) {
    return;
  }

  MoonlightInstance::ClLogMessage(
    "Audio sync correction dropped %llu packets (hard=%llu, max lead=%.03f s)\n",
    static_cast<unsigned long long>(s_audioSyncDroppedPackets),
    static_cast<unsigned long long>(s_audioSyncHardDrops),
    s_audioSyncMaxLeadSeconds
  );
  s_audioSyncDroppedPackets = 0;
  s_audioSyncHardDrops = 0;
  s_audioSyncMaxLeadSeconds = 0.0;
  s_lastAudioSyncLog = now;
}

static DecodeAppendOutcome DecodeAndAppendPacket(
  samsung::wasm::ElementaryMediaTrack* track,
  samsung::wasm::SessionId session_id,
  OpusMSDecoder* decoder, const unsigned char* sampleData, int sampleLength) {
  int decodeLen;
  
  // Decode the incoming audio packet using Opus decoder
  decodeLen = opus_multistream_decode(
    decoder, sampleData, sampleLength,
    s_DecodeBuffer.data(), s_samplesPerFrame, 0
  );

  // Check if audio decoding failed
  if (decodeLen <= 0) {
    // Reset the buffer contents to zero when decoding fails
    s_DecodeBuffer.assign(s_DecodeBuffer.size(), 0);
    return DecodeAppendOutcome::DecodeFailed;
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
  if (track->AppendPacket(pkt)) {
    // If successful, update the presentation timestamp for the next packet
    s_pktPts += s_frameDuration;
  } else {
    MoonlightInstance::ClLogMessage("Append audio packet failed\n");
    return DecodeAppendOutcome::AppendFailed;
  }

  // Resize decode buffer if it's smaller than the desired size
  if (s_desiredBufferSize > s_DecodeBuffer.size()) {
    s_DecodeBuffer.resize(s_desiredBufferSize);
  }

  return DecodeAppendOutcome::Appended;
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
  s_audioSyncDroppedPackets = 0;
  s_audioSyncHardDrops = 0;
  s_audioSyncMaxLeadSeconds = 0.0;

  // Flag indicating whether this is the first frame of audio to be decoded
  s_hasFirstFrame = false;

  // Set the audio synchronization flag based on instance configuration
  s_AudioSyncEnabled = g_Instance->m_AudioSyncEnabled;

  return 0;
}

void MoonlightInstance::AudDecCleanup(void) {
  MaybeLogAudioSyncCorrection(std::chrono::steady_clock::now());

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
  // Check if audio playback has not started
  if (!g_Instance->m_AudioStarted || !g_Instance->m_OpusDecoder) {
    return;
  }

  // Check if this is the first audio frame
  if (!s_hasFirstFrame) {
    // Record the time of the first frame
    s_firstAppend = std::chrono::steady_clock::now();
    s_lastAudioSyncLog = s_firstAppend;
    // Update the flag to indicate that the first frame has been processed
    s_hasFirstFrame = true;
  }

  // Get the current time and calculate the time elapsed since the first frame
  auto now = std::chrono::steady_clock::now();
  TimeStamp ntp = now - s_firstAppend;
  MaybeLogAudioSyncCorrection(now);

  if (s_AudioSyncEnabled) {
    const auto syncDecision = s_AudioSyncController.ObservePacket(ntp.count());
    if (syncDecision != AudioSyncDecision::Append) {
      ++s_audioSyncDroppedPackets;
      if (syncDecision == AudioSyncDecision::DropHard) {
        ++s_audioSyncHardDrops;
      }
      s_audioSyncMaxLeadSeconds = std::max(
        s_audioSyncMaxLeadSeconds,
        s_AudioSyncController.EstimatedLead(ntp.count())
      );
      return;
    }
  }

  // Decode and append the audio packet to the audio track
  const auto decodeOutcome = DecodeAndAppendPacket(&g_Instance->m_AudioTrack,
    g_Instance->m_AudioSessionId.load(), g_Instance->m_OpusDecoder,
    reinterpret_cast<unsigned char*>(sampleData), sampleLength
  );

  if (decodeOutcome == DecodeAppendOutcome::Appended) {
    s_AudioSyncController.CommitAppend(ntp.count(), s_frameDuration.count());
  }
}

AUDIO_RENDERER_CALLBACKS MoonlightInstance::s_ArCallbacks = {
  .init = MoonlightInstance::AudDecInit,
  .cleanup = MoonlightInstance::AudDecCleanup,
  .decodeAndPlaySample = MoonlightInstance::AudDecDecodeAndPlaySample,
  .capabilities = CAPABILITY_DIRECT_SUBMIT,
};
