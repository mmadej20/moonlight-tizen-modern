#include "moonlight_wasm.hpp"
#include "media_track_diagnostics.hpp"
#include "video_timing.hpp"

#include <algorithm>
#include <condition_variable>
#include <cstdio>
#include <functional>
#include <mutex>
#include <thread>

#include <h264_stream.h>

#include <assert.h>
#include <pthread.h>

#include "samsung/wasm/elementary_audio_track_config.h"
#include "samsung/wasm/elementary_media_packet.h"
#include "samsung/wasm/elementary_video_track_config.h"
#include "samsung/html/html_media_element_listener.h"
#include "samsung/wasm/operation_result.h"

#define INITIAL_DECODE_BUFFER_LEN 1024 * 1024
#define MAX_SPS_EXTRA_SIZE 32

using std::chrono_literals::operator""s;
using std::chrono_literals::operator""ms;
using EmssReadyState = samsung::wasm::ElementaryMediaStreamSource::ReadyState;
using EmssOperationResult = samsung::wasm::OperationResult;
using EmssAsyncResult = samsung::wasm::OperationResult;
using HTMLAsyncResult = samsung::wasm::OperationResult;
using TimeStamp = samsung::wasm::Seconds;

static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kSourceClosed
  ) == 0
);
static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kSourceError
  ) == 1
);
static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kSourceDetached
  ) == 2
);
static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kSourceSuspended
  ) == 3
);
static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kTrackDisabled
  ) == 4
);
static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kTrackEnded
  ) == 5
);
static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kTrackSeeking
  ) == 6
);
static_assert(
  static_cast<int>(
    samsung::wasm::ElementaryMediaTrack::CloseReason::kUnknown
  ) == 7
);

static constexpr TimeStamp kFrameTimeMargin = 0.5ms;
static constexpr uint32_t kPacingDiscontinuityThresholdMs = 250;
static constexpr std::chrono::microseconds kInitialPacingSpinWindow(200);
static constexpr std::chrono::microseconds kMinimumPacingSpinWindow(50);
static constexpr std::chrono::microseconds kMaximumPacingSpinWindow(300);
static constexpr double kPacingSpinWindowAlpha = 0.25;
static constexpr uint32_t kSampleRate = 48000;

static uint32_t s_VideoFormat = 0;
static uint32_t s_Width = 0;
static uint32_t s_Height = 0;
static uint32_t s_Framerate = 0;

static std::vector<unsigned char> s_DecodeBuffer;

static TimeStamp s_frameDuration;
static VideoTimestampState s_TimestampState;
static AdaptiveSpinWindow s_AdaptiveSpinWindow(
  kInitialPacingSpinWindow,
  kMinimumPacingSpinWindow,
  kMaximumPacingSpinWindow,
  kPacingSpinWindowAlpha
);

// Where presentation time zero plays, as an offset that follows the frames of the last two seconds (see video_timing.hpp). It used to be
// the arrival of the first frame, for good, so a late first frame became the delay of the whole stream. The cap is set by the frame rate.
static PlayoutAnchor s_PlayoutAnchor(50000);

static bool s_hasFirstFrame = false;
static bool s_HasSubmittedVideoConfig = false;
static bool s_FramePacingEnabled = false;

static uint64_t total_bytes = 0;
static int m_LastFrameNumber = 0;
static bool s_HasLastFrameNumber = false;

static std::string s_StatString = "";

// When the last frame of the stream arrived, to measure the gap to the next one (0 before the first)
static uint64_t s_LastFrameCallbackMs = 0;
static VIDEO_STATS m_ActiveWndVideoStats;
static VIDEO_STATS m_LastWndVideoStats;
static VIDEO_STATS m_GlobalVideoStats;
static std::mutex s_VideoStatsMutex;

MoonlightInstance::SourceListener::SourceListener(
  MoonlightInstance* instance,
  MediaOperationEpoch::Context mediaContext
) : m_Instance(instance),
    m_MediaContext(mediaContext) {}

void MoonlightInstance::SourceListener::OnSourceOpen() {
  m_Instance->m_MediaOperationEpoch.RunIfActive(m_MediaContext, [this] {
    ClLogMessage("EMSS::OnOpen\n");
    {
      std::lock_guard<std::mutex> lock(m_Instance->m_Mutex);
      m_Instance->m_EmssReadyState = EmssReadyState::kOpen;
    }
    m_Instance->m_SourceOpenLatch.Succeed();
  });
}

void MoonlightInstance::SourceListener::OnSourceOpenPending() {
  m_Instance->m_MediaOperationEpoch.RunIfActive(m_MediaContext, [this] {
    ClLogMessage("EMSS::OnOpenPending\n");
    std::lock_guard<std::mutex> lock(m_Instance->m_Mutex);
    m_Instance->m_EmssReadyState = EmssReadyState::kOpenPending;
  });
}

void MoonlightInstance::SourceListener::OnSourceClosed() {
  m_Instance->m_MediaOperationEpoch.RunIfActive(m_MediaContext, [this] {
    ClLogMessage("EMSS::OnClosed\n");
    {
      std::lock_guard<std::mutex> lock(m_Instance->m_Mutex);
      m_Instance->m_EmssReadyState = EmssReadyState::kClosed;
    }
    m_Instance->m_InitialSourceCloseLatch.Succeed();
  });
}

MoonlightInstance::AudioTrackListener::AudioTrackListener(
  MoonlightInstance* instance,
  MediaOperationEpoch::Context mediaContext
) : m_Instance(instance),
    m_MediaContext(mediaContext) {}

void MoonlightInstance::AudioTrackListener::OnTrackOpen() {
  m_Instance->m_MediaOperationEpoch.RunIfActive(m_MediaContext, [this] {
    const auto currentSession = m_Instance->m_AudioTrack.GetSessionId();
    const bool currentSessionAvailable =
      static_cast<bool>(currentSession);
    const auto message = FormatMediaTrackOpen(
      "AUDIO",
      static_cast<int>(m_Instance->m_AudioSessionId.load()),
      currentSessionAvailable,
      currentSessionAvailable
        ? static_cast<int>(currentSession.value)
        : 0,
      static_cast<int>(currentSession.operation_result)
    );
    ClLogMessage("%s\n", message.c_str());
    {
      std::lock_guard<std::mutex> lock(m_Instance->m_Mutex);
      m_Instance->m_AudioStarted = true;
    }
    m_Instance->m_AudioTrackOpenLatch.Succeed();
  });
}

void MoonlightInstance::AudioTrackListener::OnTrackClosed(
  samsung::wasm::ElementaryMediaTrack::CloseReason reason
) {
  m_Instance->m_MediaOperationEpoch.RunIfActive(
    m_MediaContext,
    [this, reason] {
      const auto message = FormatMediaTrackClosed(
        "AUDIO",
        static_cast<int>(reason),
        static_cast<int>(m_Instance->m_AudioSessionId.load())
      );
      ClLogMessage("%s\n", message.c_str());
      {
        std::lock_guard<std::mutex> lock(m_Instance->m_Mutex);
        m_Instance->m_AudioStarted = false;
      }
      m_Instance->m_AudioTrackOpenLatch.Fail();
    });
}

void MoonlightInstance::AudioTrackListener::OnSessionIdChanged(samsung::wasm::SessionId new_session_id) {
  m_Instance->m_MediaOperationEpoch.RunIfActive(
    m_MediaContext,
    [this, new_session_id] {
      const auto message = FormatMediaTrackSessionChanged(
        "AUDIO",
        static_cast<int>(m_Instance->m_AudioSessionId.load()),
        static_cast<int>(new_session_id)
      );
      ClLogMessage("%s\n", message.c_str());
      std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
      m_Instance->m_AudioSessionId.store(new_session_id);
    });
}

MoonlightInstance::VideoTrackListener::VideoTrackListener(
  MoonlightInstance* instance,
  MediaOperationEpoch::Context mediaContext
) : m_Instance(instance),
    m_MediaContext(mediaContext) {}

void MoonlightInstance::VideoTrackListener::OnTrackOpen() {
  m_Instance->m_MediaOperationEpoch.RunIfActive(m_MediaContext, [this] {
    const auto currentSession = m_Instance->m_VideoTrack.GetSessionId();
    const bool currentSessionAvailable =
      static_cast<bool>(currentSession);
    const auto message = FormatMediaTrackOpen(
      "VIDEO",
      static_cast<int>(m_Instance->m_VideoSessionId.load()),
      currentSessionAvailable,
      currentSessionAvailable
        ? static_cast<int>(currentSession.value)
        : 0,
      static_cast<int>(currentSession.operation_result)
    );
    ClLogMessage("%s\n", message.c_str());
    {
      std::lock_guard<std::mutex> lock(m_Instance->m_Mutex);
      m_Instance->m_VideoStarted = true;
    }
    m_Instance->m_VideoTrackOpenLatch.Succeed();
    LiRequestIdrFrame();
  });
}

void MoonlightInstance::VideoTrackListener::OnTrackClosed(
  samsung::wasm::ElementaryMediaTrack::CloseReason reason
) {
  m_Instance->m_MediaOperationEpoch.RunIfActive(
    m_MediaContext,
    [this, reason] {
      const auto message = FormatMediaTrackClosed(
        "VIDEO",
        static_cast<int>(reason),
        static_cast<int>(m_Instance->m_VideoSessionId.load())
      );
      ClLogMessage("%s\n", message.c_str());
      {
        std::lock_guard<std::mutex> lock(m_Instance->m_Mutex);
        m_Instance->m_VideoStarted = false;
      }
      m_Instance->m_VideoTrackOpenLatch.Fail();
    });
}

void MoonlightInstance::VideoTrackListener::OnSessionIdChanged(samsung::wasm::SessionId new_session_id) {
  m_Instance->m_MediaOperationEpoch.RunIfActive(
    m_MediaContext,
    [this, new_session_id] {
      const auto message = FormatMediaTrackSessionChanged(
        "VIDEO",
        static_cast<int>(m_Instance->m_VideoSessionId.load()),
        static_cast<int>(new_session_id)
      );
      ClLogMessage("%s\n", message.c_str());
      std::unique_lock<std::mutex> lock(m_Instance->m_Mutex);
      m_Instance->m_VideoSessionId.store(new_session_id);
    });
}

void MoonlightInstance::DidChangeFocus(bool got_focus) {
  // Request an IDR frame to dump the frame queue that may have
  // built up from the GL pipeline being stalled.
  if (got_focus) {
    LiRequestIdrFrame();
  }
}

bool MoonlightInstance::InitializeRenderingSurface(int width, int height) {
  return true;
}

bool MoonlightInstance::WaitForMediaStage(const char* stage, OperationLatch& latch) {
  const OperationOutcome outcome = latch.WaitFor(10s, m_ConnectionCancelled);
  if (outcome == OperationOutcome::Success) {
    ClLogMessage("EMSS %s succeeded\n", stage);
    return true;
  }
  if (outcome == OperationOutcome::Timeout) {
    ClLogMessage("EMSS %s timed out after 10 seconds\n", stage);
  } else if (outcome == OperationOutcome::Cancelled) {
    ClLogMessage("EMSS %s cancelled\n", stage);
  } else {
    ClLogMessage("EMSS %s failed\n", stage);
  }
  return false;
}

int MoonlightInstance::MediaSetupFailureCode() const {
  // A stop requested by the user is not a video setup failure, so it keeps the generic error code
  if (m_ConnectionCancelled.load()) {
    return -1;
  }
  return ERROR_VIDEO_SETUP_FAILED;
}

int MoonlightInstance::StartupVidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags) {
  MoonlightInstance* instance = g_Instance;
  if (!instance->m_Source || !instance->m_Source->IsValid()) {
    ClLogMessage("EMSS source is unavailable or invalid during setup\n");
    return -1;
  }

  if (!instance->m_CurrentMediaListeners) {
    ClLogMessage("EMSS callback listeners are unavailable during setup\n");
    return -1;
  }

  const auto sourceListenerResult =
    instance->m_Source->SetListener(&instance->m_CurrentMediaListeners->source);
  if (!sourceListenerResult) {
    ClLogMessage("Failed to set EMSS source listener\n");
    return -1;
  }

  const auto setSourceResult = instance->m_MediaElement.SetSrc(instance->m_Source.get());
  if (!setSourceResult) {
    ClLogMessage("Failed to bind EMSS source to media element\n");
    return -1;
  }
  if (!instance->WaitForMediaStage("initial source close", instance->m_InitialSourceCloseLatch)) {
    return instance->MediaSetupFailureCode();
  }

  // The Web Audio backend renders the audio itself in platform/audio.js, so the EMSS audio
  // track is only added when the EMSS backend is selected
  if (g_Instance->m_AudioBackend == AudioBackend::Emss) {
    samsung::wasm::ChannelLayout channelLayout; // Selected audio channel layout from audio config
    switch (CHANNEL_COUNT_FROM_AUDIO_CONFIGURATION(instance->m_AudioConfig)) {
      case 2:
        channelLayout = samsung::wasm::ChannelLayout::kStereo; // Audio Channel: Stereo
        ClLogMessage("Selected channel layout for Stereo audio\n");
        break;
      case 6:
        channelLayout = samsung::wasm::ChannelLayout::k5_1; // Audio Channel: 5.1 Surround Sound
        ClLogMessage("Selected channel layout for 5.1 Surround audio\n");
        break;
      case 8:
        channelLayout = samsung::wasm::ChannelLayout::k7_1; // Audio Channel: 7.1 Surround Sound
        ClLogMessage("Selected channel layout for 7.1 Surround audio\n");
        break;
      default:
        ClLogMessage("Unable to select channel layout from audio configuration\n");
        return -1;
    }

    auto add_track_result = instance->m_Source->AddTrack(
      samsung::wasm::ElementaryAudioTrackConfig {
        "audio/webm; codecs=\"pcm\"", // Audio Codec: Pulse Code Modulation (PCM) Profile
        {}, // Extradata: Empty
        samsung::wasm::DecodingMode::kHardware, // Decoding mode: Hardware
        samsung::wasm::SampleFormat::kS16, // Sample Format: 16-bit signed integer (S16)
        channelLayout, // Channel Layout: Stereo (2-CH), 5.1 Surround (6-CH), 7.1 Surround (8-CH)
        kSampleRate, // Sample Rate: 48 kHz (48000 Hz)
      }
    );
    if (!add_track_result) {
      ClLogMessage("Failed to add EMSS audio track\n");
      return -1;
    }
    instance->m_AudioTrack = std::move(*add_track_result);
    const auto audioListenerResult =
      instance->m_AudioTrack.SetListener(&instance->m_CurrentMediaListeners->audio);
    if (!audioListenerResult) {
      ClLogMessage("Failed to set EMSS audio track listener\n");
      return -1;
    }
  }

  {
    const char *mimetype = "video/mp4"; // MIME-type: Video MP4 Container
    if (videoFormat & VIDEO_FORMAT_H264) {
      mimetype = "video/mp4; codecs=\"avc1.64002A\""; // Video codec: H.264 High Level Profile 4.2
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.1 (avc1.640033); */
      ClLogMessage("Video codec profile selected: H.264 High Level Profile 4.2\n");
    } else if (videoFormat & VIDEO_FORMAT_H265) {
      mimetype = "video/mp4; codecs=\"hev1.1.6.L153.B0\""; // Video Codec: HEVC Main Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (hev1.1.6.L156.B0); */
      ClLogMessage("Video codec profile selected: HEVC Main Level Profile 5.1\n");
    } else if (videoFormat & VIDEO_FORMAT_H265_MAIN10) {
      mimetype = "video/mp4; codecs=\"hev1.2.4.L153.B0\""; // Video Codec: HEVC Main10 Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (hev1.2.4.L156.B0); */
      ClLogMessage("Video codec profile selected: HEVC Main10 Level Profile 5.1\n");
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN8) {
      mimetype = "video/mp4; codecs=\"av01.0.13M.08\""; // Video Codec: AV1 Main Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (av01.0.14M.08); */
      ClLogMessage("Video codec profile selected: AV1 Main Level Profile 5.1\n");
    } else if (videoFormat & VIDEO_FORMAT_AV1_MAIN10) {
      mimetype = "video/mp4; codecs=\"av01.0.13M.10\""; // Video Codec: AV1 Main10 Level Profile 5.1
      /* NOTE: Depending on the capabilities of the TV, it may support higher-level codec profiles, such as:
      5.2 (av01.0.14M.10); */
      ClLogMessage("Video codec profile selected: AV1 Main10 Level Profile 5.1\n");
    } else {
      ClLogMessage("Failed to select video codec profile (videoFormat=0x%x)\n", videoFormat);
      return -1;
    }

    ClLogMessage("Using mimeType %s\n", mimetype);
    auto add_track_result = instance->m_Source->AddTrack(
      samsung::wasm::ElementaryVideoTrackConfig {
        mimetype, // MIME-type: Selected Video Format
        {}, // Extradata: Empty
        samsung::wasm::DecodingMode::kHardware, // Decoding mode: Hardware
        static_cast<uint32_t>(width), // Video resolution: Width
        static_cast<uint32_t>(height), // Video resolution: Height
        static_cast<uint32_t>(redrawRate), // Framerate: Numerator
        1, // Framerate: Denominator
      }
    );
    if (!add_track_result) {
      // Fail now, because a track that was never added will never open
      ClLogMessage("The TV rejected the video track (%s, %dx%d at %d FPS)\n", mimetype, width, height, redrawRate);
      return ERROR_VIDEO_SETUP_FAILED;
    }
    instance->m_VideoTrack = std::move(*add_track_result);
    const auto videoListenerResult =
      instance->m_VideoTrack.SetListener(&instance->m_CurrentMediaListeners->video);
    if (!videoListenerResult) {
      ClLogMessage("Failed to set EMSS video track listener\n");
      return -1;
    }
  }

  const auto mediaContext = instance->m_StreamMediaContext;
  const auto openResult = instance->m_Source->Open(
    [instance, mediaContext](EmssOperationResult result) {
      instance->m_MediaOperationEpoch.RunIfActive(mediaContext, [instance, result] {
        if (result != EmssOperationResult::kSuccess) {
          ClLogMessage("EMSS source open callback failed\n");
          instance->m_SourceOpenLatch.Fail();
        }
      });
    });
  if (!openResult) {
    ClLogMessage("Failed to start EMSS source open\n");
    instance->m_SourceOpenLatch.Fail();
    return -1;
  }
  if (!instance->WaitForMediaStage("source open", instance->m_SourceOpenLatch)) {
    return instance->MediaSetupFailureCode();
  }

  const auto playResult = instance->m_MediaElement.Play(
    [instance, mediaContext](EmssOperationResult result) {
      instance->m_MediaOperationEpoch.RunIfActive(mediaContext, [instance, result] {
        if (result != EmssOperationResult::kSuccess) {
          ClLogMessage("Media element play callback reported failure\n");
        }
      });
    });
  if (!playResult) {
    ClLogMessage("Failed to start media element playback\n");
    return -1;
  }
  // Some Tizen 9 TVs open both EMSS tracks but never complete Play's callback.
  // Track-open events are the reliable readiness signal on those devices.
  if ((instance->m_AudioBackend == AudioBackend::Emss &&
       !instance->WaitForMediaStage("audio track open", instance->m_AudioTrackOpenLatch)) ||
      !instance->WaitForMediaStage("video track open", instance->m_VideoTrackOpenLatch)) {
    return instance->MediaSetupFailureCode();
  }

  ClLogMessage("Started\n");
  return 0;
}

int MoonlightInstance::VidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags) {
  ClLogMessage("Video decoding setup has started.\n");

  // Resize the decode buffer based on initial decode buffer length
  s_DecodeBuffer.resize(INITIAL_DECODE_BUFFER_LEN);

  // Set the video format, video resolution and video frame rate based on the input parameters
  s_VideoFormat = videoFormat;
  s_Width = width;
  s_Height = height;
  s_Framerate = redrawRate;

  // Calculate frame duration from the frame rate
  s_frameDuration = TimeStamp(1.0 / static_cast<double>(redrawRate));

  // Reset timestamp state for the new stream.
  s_TimestampState = {};
  s_AdaptiveSpinWindow = AdaptiveSpinWindow(
    kInitialPacingSpinWindow,
    kMinimumPacingSpinWindow,
    kMaximumPacingSpinWindow,
    kPacingSpinWindowAlpha
  );

  // Every stream starts with an empty window, and holds a frame for three frame intervals at most
  s_PlayoutAnchor = PlayoutAnchor(PlayoutMaxBufferUs(static_cast<int64_t>(std::llround(1000000.0 / static_cast<double>(redrawRate)))));

  // Flag indicating whether this is the first frame of video to be decoded
  s_hasFirstFrame = false;
  s_HasSubmittedVideoConfig = false;
  s_HasLastFrameNumber = false;
  s_LastFrameCallbackMs = 0;
  m_LastFrameNumber = 0;
  total_bytes = 0;

  // Set the frame pacing flag based on instance configuration
  s_FramePacingEnabled = g_Instance->m_FramePacingEnabled;

  {
    std::lock_guard<std::mutex> statsLock(s_VideoStatsMutex);

    // Preallocate and clear the performance stats string.
    s_StatString.assign(1000, '\0');

    // Clear active window video statistics to start fresh
    memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));

    // Clear last window video statistics from previous session
    memset(&m_LastWndVideoStats, 0, sizeof(m_LastWndVideoStats));

    // Reset global video statistics for new decoding session
    memset(&m_GlobalVideoStats, 0, sizeof(m_GlobalVideoStats));
  }

  // Reset last frame number to prevent massive integer underflow on subsequent streams
  m_LastFrameNumber = 0;

  // Reset the received byte count so the bitrate doesn't include data from a previous stream
  total_bytes = 0;

  // Ensure that StartupVidDecSetup is called every time when VidDecSetup is invoked to reinitialize the media pipeline
  int initVidDec = StartupVidDecSetup(videoFormat, width, height, redrawRate, context, drFlags);

  // Check and handle errors from video decoding configuration and propagating failures
  if (initVidDec != 0) {
    ClLogMessage("Initialization of video decoding configuration failed: %d\n", initVidDec);
    return initVidDec;
  }

  return DR_OK;
}

void MoonlightInstance::VidDecCleanup(void) {
  // Clear the decode buffer
  s_DecodeBuffer.clear();

  // Shrink the decode buffer to fit its contents
  s_DecodeBuffer.shrink_to_fit();
}

int MoonlightInstance::VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit) {
  if (!g_Instance->m_VideoStarted.load() || g_Instance->m_ConnectionCancelled.load()) {
    return DR_OK;
  }

  const uint64_t callbackTimeMs = LiGetMillis();
  const auto assemblyStart = std::chrono::steady_clock::now();
  unsigned int totalLength = decodeUnit->fullLength;
  if (decodeUnit->frameType == FRAME_TYPE_IDR) {
    totalLength += MAX_SPS_EXTRA_SIZE;
  }

  if (totalLength > s_DecodeBuffer.size()) {
    s_DecodeBuffer.resize(totalLength);
  }

  PLENTRY entry = decodeUnit->bufferList;
  unsigned int offset = 0;
  while (entry != NULL) {
    memcpy(&s_DecodeBuffer[offset], entry->data, entry->length);
    offset += entry->length;
    entry = entry->next;
  }
  const auto assemblyEnd = std::chrono::steady_clock::now();

  VideoTimestampState candidateTimestampState = s_TimestampState;
  const VideoTimestampUpdate timestampUpdate = UpdatePresentationTimestamp(
    decodeUnit->presentationTimeMs,
    candidateTimestampState,
    kPacingDiscontinuityThresholdMs
  );
  const double packetPtsSeconds = timestampUpdate.seconds;
  const TimeStamp packetPts(packetPtsSeconds);

  AdaptiveSpinWindow candidateAdaptiveSpinWindow = s_AdaptiveSpinWindow;
  PlayoutAnchor candidatePlayoutAnchor = s_PlayoutAnchor;
  auto candidateFirstAppend = std::chrono::steady_clock::time_point();
  const auto pacingStart = std::chrono::steady_clock::now();
  // When the frame arrived, minus its timestamp: the offset that the anchor of the pacing follows
  const int64_t packetPtsUs = static_cast<int64_t>(std::llround(packetPtsSeconds * 1000000.0));
  const int64_t arrivalOffsetUs = std::chrono::duration_cast<std::chrono::microseconds>(pacingStart.time_since_epoch()).count() - packetPtsUs;
  if (!s_hasFirstFrame || timestampUpdate.resetPacing) {
    candidatePlayoutAnchor.Reset();
  }

  if (s_FramePacingEnabled) {
    const int64_t anchorOffsetUs = candidatePlayoutAnchor.Observe(arrivalOffsetUs);
    candidateFirstAppend = std::chrono::steady_clock::time_point(
      std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::microseconds(anchorOffsetUs)));
    const auto targetTime = candidateFirstAppend
      + std::chrono::duration_cast<std::chrono::steady_clock::duration>(
          std::chrono::duration<double>(packetPtsSeconds))
      - std::chrono::duration_cast<std::chrono::steady_clock::duration>(kFrameTimeMargin);

    while (!g_Instance->m_ConnectionCancelled.load()) {
      const auto now = std::chrono::steady_clock::now();
      const auto remaining = std::chrono::duration_cast<std::chrono::microseconds>(targetTime - now);
      const auto spinWindow = candidateAdaptiveSpinWindow.value();
      if (remaining <= spinWindow) {
        break;
      }

      const auto sleepDuration = std::min(
        remaining - spinWindow,
        std::chrono::duration_cast<std::chrono::microseconds>(2ms)
      );
      const auto sleepStart = std::chrono::steady_clock::now();
      std::this_thread::sleep_for(sleepDuration);
      const auto sleepEnd = std::chrono::steady_clock::now();
      const auto expectedWake = sleepStart
        + std::chrono::duration_cast<std::chrono::steady_clock::duration>(sleepDuration);
      const auto overshoot = std::chrono::duration_cast<std::chrono::microseconds>(
        sleepEnd - expectedWake
      );
      candidateAdaptiveSpinWindow.ObserveOvershoot(std::max(
        overshoot,
        std::chrono::microseconds::zero()
      ));
    }

    const auto spinWindow = candidateAdaptiveSpinWindow.value();
    const auto spinStart = std::chrono::steady_clock::now();
    while (!g_Instance->m_ConnectionCancelled.load()
        && std::chrono::steady_clock::now() < targetTime) {
      if (std::chrono::steady_clock::now() - spinStart > spinWindow) {
        std::this_thread::yield();
      }
    }
  }
  if (g_Instance->m_ConnectionCancelled.load()) {
    return DR_OK;
  }
  const auto pacingEnd = std::chrono::steady_clock::now();

  std::unique_lock<std::mutex> statsLock(s_VideoStatsMutex);
  bool postStats = false;
  std::string statMessage;
  char windowLine[400];
  windowLine[0] = 0;

  if (m_ActiveWndVideoStats.measurementStartTimestamp == 0) {
    m_ActiveWndVideoStats.measurementStartTimestamp = callbackTimeMs;
  }
  if (s_LastFrameCallbackMs != 0 && callbackTimeMs > s_LastFrameCallbackMs) {
    m_ActiveWndVideoStats.maxFrameGapMs = MAX(
      m_ActiveWndVideoStats.maxFrameGapMs,
      static_cast<uint32_t>(callbackTimeMs - s_LastFrameCallbackMs)
    );
  }
  s_LastFrameCallbackMs = callbackTimeMs;
  if (s_HasLastFrameNumber && decodeUnit->frameNumber > m_LastFrameNumber + 1) {
    const uint32_t droppedFrames = decodeUnit->frameNumber - (m_LastFrameNumber + 1);
    m_ActiveWndVideoStats.networkDroppedFrames += droppedFrames;
    m_ActiveWndVideoStats.totalFrames += droppedFrames;
  }
  m_LastFrameNumber = decodeUnit->frameNumber;
  s_HasLastFrameNumber = true;

  // Update min host processing latency if a valid value was provided
  if (decodeUnit->frameHostProcessingLatency != 0) {
    // Take the minimum of current min latency and new latency
    if (m_ActiveWndVideoStats.minHostProcessingLatency != 0) {
      m_ActiveWndVideoStats.minHostProcessingLatency = MIN(m_ActiveWndVideoStats.minHostProcessingLatency, decodeUnit->frameHostProcessingLatency);
    } else {
      m_ActiveWndVideoStats.minHostProcessingLatency = decodeUnit->frameHostProcessingLatency;
    }
    // Count how many frames included host processing latency data
    m_ActiveWndVideoStats.framesWithHostProcessingLatency += 1;
  }

  // Update max and total host processing latency
  m_ActiveWndVideoStats.maxHostProcessingLatency = MAX(m_ActiveWndVideoStats.maxHostProcessingLatency, decodeUnit->frameHostProcessingLatency);
  m_ActiveWndVideoStats.totalHostProcessingLatency += decodeUnit->frameHostProcessingLatency;

  m_ActiveWndVideoStats.receivedFrames++;
  m_ActiveWndVideoStats.totalFrames++;
  if (callbackTimeMs >= decodeUnit->enqueueTimeMs) {
    m_ActiveWndVideoStats.totalQueueTimeUs += (callbackTimeMs - decodeUnit->enqueueTimeMs) * 1000;
  }
  m_ActiveWndVideoStats.totalAssemblyTimeUs += std::chrono::duration_cast<std::chrono::microseconds>(
    assemblyEnd - assemblyStart
  ).count();
  const uint64_t pacerTimeUs = std::chrono::duration_cast<std::chrono::microseconds>(
    pacingEnd - pacingStart
  ).count();
  m_ActiveWndVideoStats.totalPacerTimeUs += pacerTimeUs;
  m_ActiveWndVideoStats.maxPacerTimeUs = MAX(m_ActiveWndVideoStats.maxPacerTimeUs, pacerTimeUs);
  // How far behind the best case the pacing holds the frames now (nothing without pacing)
  m_ActiveWndVideoStats.maxPlayoutBufferUs = MAX(
    m_ActiveWndVideoStats.maxPlayoutBufferUs,
    s_FramePacingEnabled ? static_cast<uint32_t>(candidatePlayoutAnchor.BufferUs()) : 0u
  );
  total_bytes += decodeUnit->fullLength;

  const bool includeVideoConfig = !s_HasSubmittedVideoConfig
    && decodeUnit->frameType == FRAME_TYPE_IDR;
  samsung::wasm::ElementaryMediaPacket pkt {
    packetPts, // presentation timestamp
    packetPts, // decoding timestamp
    s_frameDuration, // packet duration
    decodeUnit->frameType == FRAME_TYPE_IDR, // packet of frame type
    offset, // packet size
    s_DecodeBuffer.data(), // pointer to packet payload
    includeVideoConfig ? s_Width : 0,
    includeVideoConfig ? s_Height : 0,
    includeVideoConfig ? s_Framerate : 0,
    includeVideoConfig ? 1u : 0u,
    g_Instance->m_VideoSessionId.load() // session identifier
  };

  const auto submitStart = std::chrono::steady_clock::now();
  auto submitEnd = submitStart;
  const PacingCommitOutcome pacingCommitOutcome = AppendAndCommitPacingState(
    g_Instance->m_ConnectionCancelled,
    [&] {
      if (decodeUnit->frameType == FRAME_TYPE_IDR) {
        ClLogMessage(
          "VideoRenderer IDR append start frame=%d ptsMs=%.3f session=%d\n",
          decodeUnit->frameNumber,
          packetPtsSeconds * 1000.0,
          static_cast<int>(g_Instance->m_VideoSessionId.load())
        );
      }
      const auto appendResult = g_Instance->m_VideoTrack.AppendPacket(pkt);
      submitEnd = std::chrono::steady_clock::now();
      if (decodeUnit->frameType == FRAME_TYPE_IDR) {
        ClLogMessage(
          "VideoRenderer IDR append returned frame=%d success=%d result=%d durationUs=%llu\n",
          decodeUnit->frameNumber,
          static_cast<bool>(appendResult) ? 1 : 0,
          static_cast<int>(appendResult.operation_result),
          static_cast<unsigned long long>(
            std::chrono::duration_cast<std::chrono::microseconds>(
              submitEnd - submitStart
            ).count()
          )
        );
      }
      return static_cast<bool>(appendResult);
    },
    [&] {
      s_TimestampState = candidateTimestampState;
      s_AdaptiveSpinWindow = candidateAdaptiveSpinWindow;
      s_PlayoutAnchor = candidatePlayoutAnchor;
      if (!s_hasFirstFrame) {
        s_hasFirstFrame = true;
      }
      if (includeVideoConfig) {
        s_HasSubmittedVideoConfig = true;
      }
      m_ActiveWndVideoStats.submittedFrames++;
      const uint64_t submitTimeUs = std::chrono::duration_cast<std::chrono::microseconds>(
        submitEnd - submitStart
      ).count();
      m_ActiveWndVideoStats.totalSubmitTimeUs += submitTimeUs;
      m_ActiveWndVideoStats.maxSubmitTimeUs = MAX(m_ActiveWndVideoStats.maxSubmitTimeUs, submitTimeUs);
    }
  );
  if (pacingCommitOutcome == PacingCommitOutcome::AppendFailed) {
    ClLogMessage("Append video packet failed\n");
    return DR_NEED_IDR;
  }
  if (pacingCommitOutcome == PacingCommitOutcome::Cancelled) {
    return DR_OK;
  }
  const uint64_t nowMs = LiGetMillis();
  const uint64_t windowDurationMs = nowMs - m_ActiveWndVideoStats.measurementStartTimestamp;
  if (windowDurationMs > 1000) {
    const float bitrateMbps = static_cast<float>(total_bytes * 8.0 / (windowDurationMs * 1000.0));
    if (g_Instance->m_PerformanceStatsEnabled.load()) {
      VIDEO_STATS lastTwoWndStats = {};
      lastTwoWndStats.receivedBitrate = bitrateMbps;
      AddVideoStats(m_LastWndVideoStats, lastTwoWndStats);
      AddVideoStats(m_ActiveWndVideoStats, lastTwoWndStats);
      FormatVideoStats(lastTwoWndStats, s_StatString.data(), s_StatString.length());
      statMessage = std::string("StatMsg: ") + s_StatString.data();
      postStats = true;
      std::fill(s_StatString.begin(), s_StatString.end(), 0);
    }
    {
      // The record of the window, for the diagnostic log. Its fields are key=value so that it can be parsed, like the audio one
      const uint64_t received = std::max<uint64_t>(1, m_ActiveWndVideoStats.receivedFrames);
      const uint64_t submitted = std::max<uint64_t>(1, m_ActiveWndVideoStats.submittedFrames);
      snprintf(
        windowLine, sizeof(windowLine),
        "VideoPipelineStats windowMs=%llu received=%u submitted=%u networkDropped=%u "
        "avgQueueUs=%llu avgAssemblyUs=%llu avgPacerUs=%llu maxPacerUs=%llu avgSubmitUs=%llu maxSubmitUs=%llu "
        "maxFrameGapMs=%u playoutBufferMs=%.1f bitrateMbps=%.1f\n",
        static_cast<unsigned long long>(windowDurationMs),
        m_ActiveWndVideoStats.receivedFrames,
        m_ActiveWndVideoStats.submittedFrames,
        m_ActiveWndVideoStats.networkDroppedFrames,
        static_cast<unsigned long long>(m_ActiveWndVideoStats.totalQueueTimeUs / received),
        static_cast<unsigned long long>(m_ActiveWndVideoStats.totalAssemblyTimeUs / received),
        static_cast<unsigned long long>(m_ActiveWndVideoStats.totalPacerTimeUs / received),
        static_cast<unsigned long long>(m_ActiveWndVideoStats.maxPacerTimeUs),
        static_cast<unsigned long long>(m_ActiveWndVideoStats.totalSubmitTimeUs / submitted),
        static_cast<unsigned long long>(m_ActiveWndVideoStats.maxSubmitTimeUs),
        m_ActiveWndVideoStats.maxFrameGapMs,
        static_cast<double>(m_ActiveWndVideoStats.maxPlayoutBufferUs) / 1000.0,
        static_cast<double>(bitrateMbps)
      );
    }
    AddVideoStats(m_ActiveWndVideoStats, m_GlobalVideoStats);
    memcpy(&m_LastWndVideoStats, &m_ActiveWndVideoStats, sizeof(m_ActiveWndVideoStats));
    memset(&m_ActiveWndVideoStats, 0, sizeof(m_ActiveWndVideoStats));
    m_ActiveWndVideoStats.measurementStartTimestamp = nowMs;
    total_bytes = 0;
  }

  statsLock.unlock();
  if (windowLine[0] != 0) {
    ClLogMessage("%s", windowLine);
  }
  if (postStats) {
    PostToJs(statMessage);
  }

  return DR_OK;
}

void MoonlightInstance::AddVideoStats(VIDEO_STATS& src, VIDEO_STATS& dst) {
  // Accumulate video stats from src into dst for aggregated metrics
  dst.receivedFrames += src.receivedFrames;
  dst.submittedFrames += src.submittedFrames;
  dst.totalFrames += src.totalFrames;
  dst.networkDroppedFrames += src.networkDroppedFrames;
  dst.totalQueueTimeUs += src.totalQueueTimeUs;
  dst.totalAssemblyTimeUs += src.totalAssemblyTimeUs;
  dst.totalPacerTimeUs += src.totalPacerTimeUs;
  dst.totalSubmitTimeUs += src.totalSubmitTimeUs;
  dst.maxPacerTimeUs = MAX(dst.maxPacerTimeUs, src.maxPacerTimeUs);
  dst.maxSubmitTimeUs = MAX(dst.maxSubmitTimeUs, src.maxSubmitTimeUs);
  dst.maxFrameGapMs = MAX(dst.maxFrameGapMs, src.maxFrameGapMs);
  dst.maxPlayoutBufferUs = MAX(dst.maxPlayoutBufferUs, src.maxPlayoutBufferUs);

  // Update minimum host processing latency if it's not set or if the source has a valid smaller value
  if (dst.minHostProcessingLatency == 0) {
    dst.minHostProcessingLatency = src.minHostProcessingLatency;
  } else if (src.minHostProcessingLatency != 0) {
    dst.minHostProcessingLatency = MIN(dst.minHostProcessingLatency, src.minHostProcessingLatency);
  }

  // Update the maximum host processing latency if the current source value is higher
  dst.maxHostProcessingLatency = MAX(dst.maxHostProcessingLatency, src.maxHostProcessingLatency);
  dst.totalHostProcessingLatency += src.totalHostProcessingLatency;
  dst.framesWithHostProcessingLatency += src.framesWithHostProcessingLatency;

  // Attempt to retrieve the latest estimated RTT and variance
  if (!LiGetEstimatedRttInfo(&dst.lastRtt, &dst.lastRttVariance)) {
    // Set RTTs to 0 if unavailable
    dst.lastRtt = 0;
    dst.lastRttVariance = 0;
  } else {
    // Our logic to determine if RTT is valid depends on us never
    // getting an RTT of 0. ENet currently ensures RTTs are >= 1.
    assert(dst.lastRtt > 0);
  }

  // Get the current time in milliseconds
  auto now = LiGetMillis();

  // Initialize the measurement start point if this is the first video stat window
  if (!dst.measurementStartTimestamp) {
    dst.measurementStartTimestamp = src.measurementStartTimestamp;
  }

  // Ensure the global measurement timestamp has already started first
  assert(dst.measurementStartTimestamp <= src.measurementStartTimestamp);

  const uint64_t elapsedMs = now - dst.measurementStartTimestamp;
  if (elapsedMs > 0) {
    const float elapsedSeconds = static_cast<float>(elapsedMs) / 1000.0f;
    dst.totalFps = static_cast<float>(dst.totalFrames) / elapsedSeconds;
    dst.receivedFps = static_cast<float>(dst.receivedFrames) / elapsedSeconds;
    dst.submittedFps = static_cast<float>(dst.submittedFrames) / elapsedSeconds;
  }
}

void MoonlightInstance::FormatVideoStats(VIDEO_STATS& stats, char* output, int length) {
  int ret;
  int offset = 0;
  const char* codecString;

  // Start with an empty string
  output[offset] = 0;

  // Determine the video format being used and assign a readable string
  switch (s_VideoFormat) {
    case VIDEO_FORMAT_H264: // H.264 codec
      codecString = "H.264";
      break;
    case VIDEO_FORMAT_H265: // HEVC codec
      codecString = "HEVC";
      break;
    case VIDEO_FORMAT_H265_MAIN10: // HEVC Main10 codec
      if (LiGetCurrentHostDisplayHdrMode()) {
        codecString = "HEVC 10-bit HDR";
      } else {
        codecString = "HEVC 10-bit SDR";
      }
      break;
    case VIDEO_FORMAT_AV1_MAIN8: // AV1 codec
      codecString = "AV1";
      break;
    case VIDEO_FORMAT_AV1_MAIN10: // AV1 Main10 codec
      if (LiGetCurrentHostDisplayHdrMode()) {
        codecString = "AV1 10-bit HDR";
      } else {
        codecString = "AV1 10-bit SDR";
      }
      break;
    default: // Unknown codec
      assert(false);
      codecString = "UNKNOWN";
      break;
  }

  // If there is a meaningful received frame rate, print basic stream info
  if (stats.receivedFps > 0) {
    if (codecString != nullptr) {
      // Print video resolution, frame rate, and codec name
      ret = snprintf(
        &output[offset], length - offset,
        "Video stream: %dx%d %.2f FPS (Codec: %s)\n",
        s_Width, s_Height, stats.totalFps, codecString
      );
      // Abort if string formatting failed or buffer overflowed
      if (ret < 0 || ret >= length - offset) {
        assert(false);
        return;
      }
      offset += ret;
    }

    // Print frame rates for stages that are observable before the asynchronous decoder.
    ret = snprintf(
      &output[offset], length - offset,
      "Incoming frame rate from network: %.2f FPS\n"
      "Packet submission rate: %.2f FPS\n"
      "Incoming bitrate from network: %.2f Mbps\n",
      stats.receivedFps, stats.submittedFps, stats.receivedBitrate
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Only display host processing latency if latency data exists
  if (stats.framesWithHostProcessingLatency > 0) {
    // Print min, max, and average host processing latency in milliseconds
    ret = snprintf(
      &output[offset], length - offset,
      "Host processing latency min/max/average: %.1f/%.1f/%.1f ms\n",
      (float)stats.minHostProcessingLatency / 10, (float)stats.maxHostProcessingLatency / 10,
      (float)stats.totalHostProcessingLatency / 10 / stats.framesWithHostProcessingLatency
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }

  // Show remaining statistics only if packets were received and submitted.
  if (stats.receivedFrames != 0 && stats.submittedFrames != 0) {
    char rttString[32];
    // Format the round-trip time string
    if (stats.lastRtt != 0) {
      // Print the last RTT including variance in milliseconds
      snprintf(
        rttString, sizeof(rttString),
        "%u ms (variance: %u ms)",
        stats.lastRtt, stats.lastRttVariance
      );
    } else {
      // Otherwise, print as "N/A" if RTT is unavailable
      snprintf(rttString, sizeof(rttString), "N/A");
    }

    const float networkDropRate = stats.totalFrames != 0
      ? static_cast<float>(stats.networkDroppedFrames) / stats.totalFrames * 100.0f
      : 0.0f;
    ret = snprintf(
      &output[offset], length - offset,
      "Frames dropped by your network connection: %.2f%%\n"
      "Average network latency: %s\n"
      "Average packet queue delay: %.3f ms\n"
      "Average packet assembly time: %.3f ms\n"
      "Average frame pacing delay: %.3f ms\n"
      "Average packet submission time: %.3f ms\n",
      networkDropRate,
      rttString,
      static_cast<double>(stats.totalQueueTimeUs) / stats.receivedFrames / 1000.0,
      static_cast<double>(stats.totalAssemblyTimeUs) / stats.receivedFrames / 1000.0,
      static_cast<double>(stats.totalPacerTimeUs) / stats.receivedFrames / 1000.0,
      static_cast<double>(stats.totalSubmitTimeUs) / stats.submittedFrames / 1000.0
    );
    // Abort if string formatting failed or buffer overflowed
    if (ret < 0 || ret >= length - offset) {
      assert(false);
      return;
    }
    offset += ret;
  }
}

void MoonlightInstance::TogglePerformanceStats() {
  // Toggle the performance stats overlay flag
  const bool performanceStatsEnabled = !m_PerformanceStatsEnabled.load();
  m_PerformanceStatsEnabled.store(performanceStatsEnabled);

  // Notify the JS code that performance stats overlay is enabled or disabled
  if (performanceStatsEnabled) {
    std::string statMessage;
    {
      std::lock_guard<std::mutex> statsLock(s_VideoStatsMutex);
      statMessage = std::string("StatMsg: ") + s_StatString.data();
    }
    PostToJs(statMessage);
  } else {
    PostToJs(std::string("NoStatMsg: "));
  }
}

DECODER_RENDERER_CALLBACKS MoonlightInstance::s_DrCallbacks = {
  .setup = MoonlightInstance::VidDecSetup,
  .cleanup = MoonlightInstance::VidDecCleanup,
  .submitDecodeUnit = MoonlightInstance::VidDecSubmitDecodeUnit,
  .capabilities = CAPABILITY_SLICES_PER_FRAME(4),
};
