#include <atomic>
#include <chrono>
#include <memory>
#include <queue>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/html5.h>
#include <emscripten/val.h>
#include <pthread.h>
#include <future>
#include <string>

#include <Limelight.h>
#include <opus_multistream.h>

#include "connection_lifecycle.hpp"
#include "lib.hpp"
#include "media_operation_epoch.hpp"
#include "operation_latch.hpp"
#include "owned_pthread.hpp"
#include "request_registry.hpp"

#include "samsung/wasm/elementary_media_stream_source.h"
#include "samsung/wasm/elementary_media_stream_source_listener.h"
#include "samsung/wasm/elementary_media_track.h"
#include "samsung/wasm/elementary_media_track_listener.h"
#include "samsung/html/html_media_element.h"
#include "samsung/html/html_media_element_listener.h"

// Uncomment this line to enable the profiling infrastructure
// #define ENABLE_PROFILING 1

// Use this define to choose the time threshold in milliseconds above
// which a profiling message is printed
#define PROFILING_MESSAGE_THRESHOLD 1

#define DR_FLAG_FORCE_SW_DECODE 0x01

// These will mostly be I/O bound so we'll create
// a bunch to allow more concurrent server requests
// since our HTTP request library is synchronous.
#define HTTP_HANDLER_THREADS 8

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

struct MessageResult {
  std::string type;
  emscripten::val ret;

  MessageResult(std::string t = "", emscripten::val r = emscripten::val::null())
    : type(t), ret(r) {}

  static MessageResult Resolve(emscripten::val r = emscripten::val::null()) {
    return {"resolve", r};
  }
  static MessageResult Reject(emscripten::val r = emscripten::val::null()) {
    return {"reject", r};
  }
};

typedef struct _VIDEO_STATS {
  uint32_t receivedFrames;
  uint32_t submittedFrames;
  uint32_t totalFrames;
  uint32_t networkDroppedFrames;
  uint16_t minHostProcessingLatency;
  uint16_t maxHostProcessingLatency;
  uint32_t totalHostProcessingLatency;
  uint32_t framesWithHostProcessingLatency;
  uint64_t totalQueueTimeUs;
  uint64_t totalAssemblyTimeUs;
  uint64_t totalPacerTimeUs;
  uint64_t totalSubmitTimeUs;
  uint32_t lastRtt;
  uint32_t lastRttVariance;
  float totalFps;
  float receivedFps;
  float submittedFps;
  float receivedBitrate;
  uint64_t measurementStartTimestamp;
} VIDEO_STATS, *PVIDEO_STATS;

enum class LoadResult {
  Success, CertErr, PrivateKeyErr
};

// Audio backend used to render the decoded Opus stream
enum class AudioBackend {
  Emss, // Elementary Media Stream Source: the original Samsung implementation
  WebAudio, // Web Audio: the scheduler implemented in platform/audio.js
  Disabled // No audio output: the audio stream is discarded, for setups that play it through another device
};

constexpr const char* kCanvasName = "#wasm_module";

// Error code reported when the TV rejects the video stream or doesn't start it in time,
// which usually means the TV doesn't support the selected resolution or frame rate
#define ERROR_VIDEO_SETUP_FAILED -200

class MoonlightInstance {
  public:
  explicit MoonlightInstance();

  MessageResult StartStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
    std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
    bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons,
    std::string audioBackend, std::string audioConfig, bool audioSync, int audioJitterMs, bool playHostAudio, bool decryptHostAudio,
    std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode, bool disableWarnings, bool performanceStats, bool speculativeRfi);
  MessageResult StopStream();

  MessageResult CancelRequest(int callbackId);

  void STUN(int callbackId);
  void Pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber);
  void WakeOnLan(int callbackId, std::string macAddress);

  virtual ~MoonlightInstance();

  bool Init(uint32_t argc, const char* argn[], const char* argv[]);

  EM_BOOL HandleMouseDown(const EmscriptenMouseEvent& event);
  EM_BOOL HandleMouseMove(const EmscriptenMouseEvent& event);
  EM_BOOL HandleMouseUp(const EmscriptenMouseEvent& event);
  EM_BOOL HandleWheel(const EmscriptenWheelEvent& event);
  EM_BOOL HandleKeyDown(const EmscriptenKeyboardEvent& event);
  EM_BOOL HandleKeyUp(const EmscriptenKeyboardEvent& event);

  void ReportMouseMovement();

  void HandleGamepadInputState(bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons);
  void PollGamepads();

  void MouseLockLost();
  void DidLockMouse(int32_t result);

  void OnConnectionStopped(int errorCode);
  void OnConnectionStarted(uint32_t error);
  void StopConnection(int errorCode);
  OperationOutcome CloseMediaSource();

  static uint32_t ProfilerGetPackedMillis();
  static uint64_t ProfilerGetMillis();
  static uint64_t ProfilerUnpackTime(uint32_t packedTime);
  static void ProfilerPrintPackedDelta(const char* message, uint32_t packedTimeA, uint32_t packedTimeB);
  static void ProfilerPrintDelta(const char* message, uint64_t timeA, uint64_t timeB);
  static void ProfilerPrintPackedDeltaFromNow(const char* message, uint32_t packedTime);
  static void ProfilerPrintDeltaFromNow(const char* message, uint64_t time);
  static void ProfilerPrintWarning(const char* message);

  static void* ConnectionThreadFunc(void* context);
  static void* InputThreadFunc(void* context);
  static void* StopThreadFunc(void* context);

  static void ClStageStarting(int stage);
  static void ClStageFailed(int stage, int errorCode);
  static void ClConnectionStarted(void);
  static void ClConnectionTerminated(int errorCode);
  static void ClDisplayMessage(const char* message);
  static void ClDisplayTransientMessage(const char* message);
  static void ClLogMessage(const char* format, ...);
  static void ClControllerRumble(unsigned short controllerNumber, unsigned short lowFreqMotor, unsigned short highFreqMotor);
  static void ClConnectionStatusUpdate(int connectionStatus);

  void DidChangeFocus(bool got_focus);
  bool InitializeRenderingSurface(int width, int height);

  static int VidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags);
  static int StartupVidDecSetup(int videoFormat, int width, int height, int redrawRate, void* context, int drFlags);
  static void VidDecCleanup(void);
  static int VidDecSubmitDecodeUnit(PDECODE_UNIT decodeUnit);
  static void AddVideoStats(VIDEO_STATS& src, VIDEO_STATS& dst);
  static void FormatVideoStats(VIDEO_STATS& stats, char* output, int length);
  void TogglePerformanceStats();

  static int AudDecInit(int audioConfiguration, POPUS_MULTISTREAM_CONFIGURATION opusConfig, void* context, int arFlags);
  static void AudDecCleanup(void);
  static void AudDecDecodeAndPlaySample(char* sampleData, int sampleLength);

  MessageResult MakeCert();

  MessageResult HttpInit(std::string cert, std::string privateKey, std::string myUniqueId);
  void OpenUrl(int callbackId, std::string url, std::string ppk,
               bool binaryResponse, int timeoutMs);

  LoadResult LoadCert(const char* certStr, const char* keyStr);

  private:
    using EmssReadyState = samsung::wasm::ElementaryMediaStreamSource::ReadyState;
    using EmssTrackCloseReason = samsung::wasm::ElementaryMediaTrack::CloseReason;
  class SourceListener
    : public samsung::wasm::ElementaryMediaStreamSourceListener {
  public:
    SourceListener(
      MoonlightInstance* instance,
      MediaOperationEpoch::Context mediaContext);
    void OnSourceOpen() override;
    void OnSourceOpenPending() override;
    void OnSourceClosed() override;
  private:
    MoonlightInstance* m_Instance;
    const MediaOperationEpoch::Context m_MediaContext;
  };
  class AudioTrackListener
    : public samsung::wasm::ElementaryMediaTrackListener {
  public:
    AudioTrackListener(
      MoonlightInstance* instance,
      MediaOperationEpoch::Context mediaContext);
    void OnTrackOpen() override;
    void OnTrackClosed(EmssTrackCloseReason) override;
    void OnSessionIdChanged(samsung::wasm::SessionId new_session_id) override;
  private:
    MoonlightInstance* m_Instance;
    const MediaOperationEpoch::Context m_MediaContext;
  };
  class VideoTrackListener
    : public samsung::wasm::ElementaryMediaTrackListener {
  public:
    VideoTrackListener(
      MoonlightInstance* instance,
      MediaOperationEpoch::Context mediaContext);
    void OnTrackOpen() override;
    void OnTrackClosed(EmssTrackCloseReason) override;
    void OnSessionIdChanged(samsung::wasm::SessionId new_session_id) override;
  private:
    MoonlightInstance* m_Instance;
    const MediaOperationEpoch::Context m_MediaContext;
  };
  struct MediaCallbackListeners {
    MediaCallbackListeners(
      MoonlightInstance* instance,
      MediaOperationEpoch::Context mediaContext)
      : source(instance, mediaContext),
        audio(instance, mediaContext),
        video(instance, mediaContext) {}

    SourceListener source;
    AudioTrackListener audio;
    VideoTrackListener video;
  };

  bool WaitForMediaStage(const char* stage, OperationLatch& latch);
  // Error to report when a media pipeline setup step did not complete: -1 when the user cancelled
  // the stream, ERROR_VIDEO_SETUP_FAILED when the TV rejected the stream or never completed the step
  int MediaSetupFailureCode() const;

  void OpenUrl_private(
    int callbackId, std::string url, std::string ppk, bool binaryResponse,
    std::shared_ptr<HTTP_REQUEST_CONTEXT> requestContext);
  void STUN_private(int callbackId);
  void Pair_private(
    int callbackId, std::string serverMajorVersion, std::string address,
    int httpPort, std::string randomNumber,
    std::shared_ptr<HTTP_REQUEST_CONTEXT> requestContext);
  void WakeOnLan_private(int callbackId, std::string macAddress);

  void LockMouse();
  void UnlockMouse();

  static CONNECTION_LISTENER_CALLBACKS s_ClCallbacks;
  static DECODER_RENDERER_CALLBACKS s_DrCallbacks;
  static AUDIO_RENDERER_CALLBACKS s_ArCallbacks;

  std::string m_Host;
  int m_HttpPort;
  std::string m_AppVersion;
  std::string m_GfeVersion;
  std::string m_RtspUrl;
  int m_ServerCodecModeSupport;

  bool m_FramePacingEnabled;
  bool m_OptimizeGamesEnabled;
  bool m_RumbleFeedbackEnabled;
  bool m_MouseEmulationEnabled;
  bool m_FlipABfaceButtonsEnabled;
  bool m_FlipXYfaceButtonsEnabled;
  AudioBackend m_AudioBackend;
  int m_WebAudioGeneration = 0;
  int m_AudioConfig;
  bool m_AudioSyncEnabled;
  int m_AudioJitterMs;
  bool m_PlayHostAudioEnabled;
  bool m_DecryptHostAudioEnabled;
  bool m_HdrModeEnabled;
  bool m_FullRangeEnabled;
  bool m_GameModeEnabled;
  bool m_DisableWarningsEnabled;
  std::atomic<bool> m_PerformanceStatsEnabled{false};

  STREAM_CONFIGURATION m_StreamConfig;
  ConnectionLifecycle m_ConnectionLifecycle;
  std::atomic<bool> m_ConnectionCancelled{false};
  std::atomic<bool> m_TerminationReported{false};
  std::atomic<int> m_StopErrorCode{0};
  std::atomic<bool> m_Running{false};

  OwnedPthread m_ConnectionThread;
  OwnedPthread m_InputThread;
  OwnedPthread m_StopThread;

  OpusMSDecoder* m_OpusDecoder;

#ifndef SAMSUNG_TIZEN_TV
  double m_LastPadTimestamps[4];
#endif
  std::atomic<bool> m_MouseLocked;
  long m_MouseLastPosX;
  long m_MouseLastPosY;
  bool m_WaitingForAllModifiersUp;
  std::atomic<float> m_AccumulatedTicks;
  std::atomic<int32_t> m_MouseDeltaX;
  std::atomic<int32_t> m_MouseDeltaY;
  uint32_t m_HttpThreadPoolSequence;

  Dispatcher m_Dispatcher;
  HttpRequestRegistry m_HttpRequests;

  std::mutex m_Mutex;
  EmssReadyState m_EmssReadyState;
  std::atomic<bool> m_AudioStarted;
  std::atomic<bool> m_VideoStarted;
  std::atomic<samsung::wasm::SessionId> m_AudioSessionId;
  std::atomic<samsung::wasm::SessionId> m_VideoSessionId;
  MediaOperationEpoch m_MediaOperationEpoch;
  std::vector<std::unique_ptr<MediaCallbackListeners>>
    m_MediaCallbackListenerOwners;
  MediaOperationEpoch::Context m_StreamMediaContext;
  MediaCallbackListeners* m_CurrentMediaListeners;
  samsung::html::HTMLMediaElement m_MediaElement;
  std::unique_ptr<samsung::wasm::ElementaryMediaStreamSource> m_Source;
  samsung::wasm::ElementaryMediaTrack m_AudioTrack;
  samsung::wasm::ElementaryMediaTrack m_VideoTrack;
  OperationLatch m_InitialSourceCloseLatch;
  OperationLatch m_SourceOpenLatch;
  OperationLatch m_AudioTrackOpenLatch;
  OperationLatch m_VideoTrackOpenLatch;
  OperationLatch m_PlayLatch;
  OperationLatch m_SourceCloseLatch;
};

extern MoonlightInstance* g_Instance;

void PostToJs(std::string msg);
void PostToJsAsync(std::string msg);
void PostPromiseMessage(int callbackId, const std::string& type, const std::string& response);
void PostPromiseMessage(int callbackId, const std::string& type, const std::vector<uint8_t>& response);

MessageResult makeCert();

MessageResult httpInit(std::string cert, std::string privateKey, std::string myUniqueId);
void openUrl(int callbackId, std::string url, emscripten::val ppk,
             bool binaryResponse, int timeoutMs);

MessageResult startStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
  std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
  bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons,
  std::string audioBackend, std::string audioConfig, bool audioSync, int audioJitterMs, bool playHostAudio, bool decryptHostAudio,
  std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode, bool disableWarnings, bool performanceStats, bool speculativeRfi);
MessageResult stopStream();

MessageResult cancelRequest(int callbackId);

void toggleStats();
void stun(int callbackId);
void pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber, std::string uniqueId);
void wakeOnLan(int callbackId, std::string macAddress);

EM_BOOL handleKeyDown(int eventType, const EmscriptenKeyboardEvent* keyEvent, void* userData);
EM_BOOL handleKeyUp(int eventType, const EmscriptenKeyboardEvent* keyEvent, void* userData);
EM_BOOL handleMouseMove(int eventType, const EmscriptenMouseEvent* keyEvent, void* userData);
EM_BOOL handleMouseUp(int eventType, const EmscriptenMouseEvent* keyEvent, void* userData);
EM_BOOL handleMouseDown(int eventType, const EmscriptenMouseEvent* keyEvent, void* userData);
EM_BOOL handleWheel(int eventType, const EmscriptenWheelEvent* keyEvent, void* userData);
EM_BOOL handlePointerLockChange(int eventType, const EmscriptenPointerlockChangeEvent *pointerlockChangeEvent, void *userData);
EM_BOOL handlePointerLockError(int eventType, const void *reserved, void *userData);

void onConnectionStarted();
void onConnectionStopped(int errorCode);
