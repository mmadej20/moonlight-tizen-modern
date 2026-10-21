#include "moonlight_wasm.hpp"
#include "diagnostic_log.hpp"
#include "rfi_capabilities.hpp"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include <chrono>
#include <optional>
#include <errors.h>
#include <pairing.h>
#include <iostream>

extern char* g_UniqueId;

#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/threading.h>

#include <openssl/evp.h>
#include <openssl/rand.h>

#include <netinet/in.h>
#include <sys/socket.h>
#include <arpa/inet.h>

// The optimization level this module was built with (see MOONLIGHT_OPT_LEVEL in CMakeLists.txt)
#ifndef MOONLIGHT_OPT_LEVEL_TEXT
#define MOONLIGHT_OPT_LEVEL_TEXT "unknown"
#endif

// Requests the Wasm module to connect to the specified server
#define MSG_START_REQUEST "startRequest"
// Requests the Wasm module to stop streaming
#define MSG_STOP_REQUEST "stopRequest"
// Sent by the Wasm module when streaming has stopped, whether requested by the user or not
#define MSG_STREAM_TERMINATED "streamTerminated: "
// Requests the Wasm module to open the specified URL
#define MSG_OPENURL "openUrl"

using EmssLatencyMode = samsung::wasm::ElementaryMediaStreamSource::LatencyMode;
using EmssRenderingMode = samsung::wasm::ElementaryMediaStreamSource::RenderingMode;
using std::chrono_literals::operator""s;

MoonlightInstance* g_Instance;

MoonlightInstance::MoonlightInstance()
  : m_AudioBackend(AudioBackend::Emss),
    m_AudioJitterMs(0),
    m_OpusDecoder(NULL),
    m_MouseLocked(false),
    m_MouseLastPosX(-1),
    m_MouseLastPosY(-1),
    m_WaitingForAllModifiersUp(false),
    m_AccumulatedTicks(0),
    m_MouseDeltaX(0),
    m_MouseDeltaY(0),
    m_HttpThreadPoolSequence(0),
    m_Dispatcher("Curl"),
    m_Mutex(),
    m_EmssReadyState(EmssReadyState::kDetached),
    m_AudioStarted(false),
    m_VideoStarted(false),
    m_AudioSessionId(0),
    m_VideoSessionId(0),
    m_MediaOperationEpoch(),
    m_MediaCallbackListenerOwners(),
    m_StreamMediaContext(),
    m_CurrentMediaListeners(nullptr),
    m_MediaElement("wasm_module"),
    m_Source(nullptr),
    m_AudioTrack(),
    m_VideoTrack() {
      m_Dispatcher.start();
    }

MoonlightInstance::~MoonlightInstance() { 
  m_Dispatcher.stop();
}

void MoonlightInstance::OnConnectionStarted(uint32_t unused) {
  // Tell the front end
  PostToJs(std::string("Connection Established"));
}

void MoonlightInstance::OnConnectionStopped(int errorCode) {
  if (m_TerminationReported.exchange(true)) {
    return;
  }

  m_Running.store(false);

  // Unlock the mouse
  UnlockMouse();

  // Notify the JS code that the stream has ended
  PostToJs(std::string(MSG_STREAM_TERMINATED + std::to_string(errorCode)));
}

void MoonlightInstance::StopConnection(int errorCode) {
  if (!m_ConnectionLifecycle.BeginStop()) {
    return;
  }

  m_StopErrorCode.store(errorCode);
  m_ConnectionCancelled.store(true);
  m_InitialSourceCloseLatch.Notify();
  m_SourceOpenLatch.Notify();
  m_AudioTrackOpenLatch.Notify();
  m_VideoTrackOpenLatch.Notify();
  m_PlayLatch.Notify();
  m_SourceCloseLatch.Notify();

  // Interrupt pending startup before the stop owner waits for the connection
  // thread. LiStopConnection() remains owned solely by StopThreadFunc().
  LiInterruptConnection();

  // Stopping needs to happen in a separate thread to avoid a potential deadlock
  // caused by us getting a callback to the main thread while inside
  // LiStopConnection.
  const int result =
    m_StopThread.Create(MoonlightInstance::StopThreadFunc, this);
  if (result != 0) {
    int expected = 0;
    m_StopErrorCode.compare_exchange_strong(expected, result);
    ClLogMessage("Failed to create the connection stop thread: %d\n", result);
    PostToJs(
      "DialogMsg: Unable to start connection teardown (error " +
      std::to_string(result) + ")");
    return;
  }
}

void* MoonlightInstance::StopThreadFunc(void* context) {
  MoonlightInstance* me = static_cast<MoonlightInstance*>(context);

  StopSequence sequence;
  // We must join the connection thread first, because LiStopConnection must
  // not be invoked during LiStartConnection.
  sequence.joinConnectionThread = [me] { return me->m_ConnectionThread.Join(); };
  sequence.releaseRemoteInputs = [me] {
    // Force raise all modifier keys to avoid leaving them down after disconnecting
    LiSendKeyboardEvent(0xA0, KEY_ACTION_UP, 0);
    LiSendKeyboardEvent(0xA1, KEY_ACTION_UP, 0);
    LiSendKeyboardEvent(0xA2, KEY_ACTION_UP, 0);
    LiSendKeyboardEvent(0xA3, KEY_ACTION_UP, 0);
    LiSendKeyboardEvent(0xA4, KEY_ACTION_UP, 0);
    LiSendKeyboardEvent(0xA5, KEY_ACTION_UP, 0);

    // Not running anymore
    me->m_Running.store(false);
  };
  // We also need to stop this thread after the connection thread, because it
  // depends on being initialized there.
  sequence.joinInputThread = [me] { return me->m_InputThread.Join(); };
  sequence.stopConnection = [] { LiStopConnection(); };
  sequence.closeMediaSource = [me] {
    const OperationOutcome closeOutcome = me->CloseMediaSource();
    if (closeOutcome == OperationOutcome::Timeout) {
      ClLogMessage("EMSS close timed out\n");
    } else if (closeOutcome == OperationOutcome::Failure) {
      ClLogMessage("EMSS close failed\n");
    }
  };
  sequence.onJoinFailure = [me](const char* thread, int result) {
    // The stream still ends, so report why instead of the graceful code
    int expected = 0;
    me->m_StopErrorCode.compare_exchange_strong(expected, result);
    ClLogMessage("Failed to join the %s thread: %d\n", thread, result);
    PostToJs(
      std::string("DialogMsg: Connection teardown could not join the ") + thread +
      " thread (error " + std::to_string(result) + ")");
  };
  sequence.notifyStopped = [me] {
    const int stopErrorCode = me->m_StopErrorCode.load();
    emscripten_sync_run_in_main_runtime_thread(
      EM_FUNC_SIG_VI, onConnectionStopped, stopErrorCode);
  };
  sequence.markIdle = [me] {
    if (!me->m_ConnectionLifecycle.MarkIdle()) {
      ClLogMessage("Connection lifecycle failed to transition to idle\n");
    }
  };

  RunStopSequence(sequence);
  return nullptr;
}

OperationOutcome MoonlightInstance::CloseMediaSource() {
  const auto closeContext = m_MediaOperationEpoch.Begin(m_Source.get());
  m_SourceCloseLatch.Reset();
  OperationOutcome outcome = OperationOutcome::Success;

  if (m_Source) {
    const auto closeResult = m_Source->Close(
      [this, closeContext](samsung::wasm::OperationResult result) {
        m_MediaOperationEpoch.RunIfActive(closeContext, [this, result] {
          if (result == samsung::wasm::OperationResult::kSuccess) {
            m_SourceCloseLatch.Succeed();
          } else {
            m_SourceCloseLatch.Fail();
          }
        });
      });
    if (!closeResult) {
      m_SourceCloseLatch.Fail();
    }

    outcome = m_SourceCloseLatch.WaitFor(3s, m_ConnectionCancelled);
  }

  m_MediaOperationEpoch.Clear(closeContext);
  m_CurrentMediaListeners = nullptr;
  m_AudioTrack = samsung::wasm::ElementaryMediaTrack();
  m_VideoTrack = samsung::wasm::ElementaryMediaTrack();
  {
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_EmssReadyState = EmssReadyState::kDetached;
    m_AudioStarted.store(false);
    m_VideoStarted.store(false);
    m_AudioSessionId.store(0);
    m_VideoSessionId.store(0);
  }
  m_Source.reset();

  return outcome;
}

void* MoonlightInstance::InputThreadFunc(void* context) {
  MoonlightInstance* me = static_cast<MoonlightInstance*>(context);

  GamepadPollSchedule schedule;

  while (me->m_Running.load()) {
    if (schedule.ShouldPoll()) {
      schedule.Polled(me->PollGamepads());
    }
    me->ReportMouseMovement();

    // Poll every 5 ms
    usleep(5 * 1000);
  }

  return nullptr;
}

void* MoonlightInstance::ConnectionThreadFunc(void* context) {
  MoonlightInstance* me = static_cast<MoonlightInstance*>(context);

  int err;
  SERVER_INFORMATION serverInfo;

  // Post a status update before we begin
  PostToJs(std::string("Starting connection to ") + me->m_Host);

  // Populate the server information
  LiInitializeServerInformation(&serverInfo);
  serverInfo.address = me->m_Host.c_str();
  serverInfo.serverInfoAppVersion = me->m_AppVersion.c_str();
  serverInfo.serverInfoGfeVersion = me->m_GfeVersion.c_str();
  serverInfo.rtspSessionUrl = me->m_RtspUrl.c_str();

  // Initialize the server codec mode support with default value
  serverInfo.serverCodecModeSupport = 0;
  // Handle setting of server codec mode support values ​​based on the selected video format
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_H264) { // H.264
    // Apply the appropriate value for the H.264 server codec
    serverInfo.serverCodecModeSupport |= SCM_H264;
    PostToJs("Selecting the server code mode to: SCM_H264");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_H265) { // HEVC
    // Apply the appropriate value for the HEVC server codec
    serverInfo.serverCodecModeSupport |= SCM_HEVC;
    PostToJs("Selecting the server code mode to: SCM_HEVC");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_H265_MAIN10) { // HEVC Main10
    // Apply the appropriate value for the HEVC Main10 server codec
    serverInfo.serverCodecModeSupport |= SCM_HEVC_MAIN10;
    PostToJs("Selecting the server code mode to: SCM_HEVC_MAIN10");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_AV1_MAIN8) { // AV1
    // Apply the appropriate value for the AV1 server codec
    serverInfo.serverCodecModeSupport |= SCM_AV1_MAIN8;
    PostToJs("Selecting the server code mode to: SCM_AV1_MAIN8");
  }
  if (me->m_StreamConfig.supportedVideoFormats & VIDEO_FORMAT_AV1_MAIN10) { // AV1 Main10
    // Apply the appropriate value for the AV1 Main10 server codec
    serverInfo.serverCodecModeSupport |= SCM_AV1_MAIN10;
    PostToJs("Selecting the server code mode to: SCM_AV1_MAIN10");
  }
  // Handle fall back logic for server codec mode support
  if (serverInfo.serverCodecModeSupport == 0) { // Unset
    // Fallback to H.264 if no server codec was selected
    serverInfo.serverCodecModeSupport = SCM_H264;
    PostToJs("Selecting the fallback server code mode to: SCM_H264");
  }

  // Initialize the audio renderer capabilities with the value shared by both audio backends
  MoonlightInstance::s_ArCallbacks.capabilities = CAPABILITY_DIRECT_SUBMIT;
  // Handle setting of the audio renderer capabilities based on the selected audio backend
  if (me->m_AudioBackend == AudioBackend::WebAudio) { // Web Audio
    // The Web Audio backend reads the samples per frame from the Opus configuration, so it can
    // render the longer frames that the RTSP negotiation may choose on low bitrate streams
    MoonlightInstance::s_ArCallbacks.capabilities |= CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION;
    PostToJs("Selecting the audio renderer capabilities to: CAPABILITY_DIRECT_SUBMIT | CAPABILITY_SUPPORTS_ARBITRARY_AUDIO_DURATION");
  } else { // EMSS, or disabled audio output
    // The EMSS backend expects the fixed 5 ms frames that are negotiated without that capability,
    // and the frame duration doesn't matter when the audio output is disabled
    PostToJs("Selecting the audio renderer capabilities to: CAPABILITY_DIRECT_SUBMIT");
  }

  err = LiStartConnection(&serverInfo, &me->m_StreamConfig, &MoonlightInstance::s_ClCallbacks,
    &MoonlightInstance::s_DrCallbacks, &MoonlightInstance::s_ArCallbacks, NULL, 0, NULL, 0);
  if (err != 0) {
    me->StopConnection(me->m_ConnectionCancelled.load() ? 0 : err);
    return nullptr;
  }

  if (!me->m_ConnectionLifecycle.MarkRunning()) {
    return nullptr;
  }

  // Set running state before starting connection-specific threads
  me->m_Running.store(true);
  if (me->m_ConnectionCancelled.load()) {
    me->m_Running.store(false);
    return nullptr;
  }

  const int inputThreadResult =
    me->m_InputThread.Create(MoonlightInstance::InputThreadFunc, me);
  if (inputThreadResult != 0) {
    me->m_Running.store(false);
    ClLogMessage("Failed to create the input thread: %d\n", inputThreadResult);
    me->StopConnection(inputThreadResult);
    return nullptr;
  }
  return nullptr;
}

static void HexStringToBytes(const char* str, char* output) {
  for (size_t i = 0; i < strlen(str); i += 2) {
    sscanf(&str[i], "%2hhx", &output[i / 2]);
  }
}

MessageResult MoonlightInstance::StartStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
  std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
  bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons,
  std::string audioBackend, std::string audioConfig, bool audioSync, int audioJitterMs, bool playHostAudio, bool decryptHostAudio,
  std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode, bool disableWarnings, bool performanceStats, bool speculativeRfi) {

  if (!m_ConnectionLifecycle.TryStart()) {
    return MessageResult::Reject(emscripten::val(GS_WRONG_STATE));
  }

  auto startGuard = m_ConnectionLifecycle.AcquireStartGuard();
  if (!startGuard) {
    return MessageResult::Reject(emscripten::val(GS_WRONG_STATE));
  }

  const int stopThreadJoinResult = m_StopThread.Join();
  if (stopThreadJoinResult != 0) {
    ClLogMessage("Failed to join the stop thread: %d\n", stopThreadJoinResult);
    // Nothing was created yet, so give the start slot back instead of leaving the lifecycle stuck
    startGuard.Release();
    m_ConnectionLifecycle.AbortStart();
    return MessageResult::Reject(emscripten::val(stopThreadJoinResult));
  }

  m_ConnectionCancelled.store(false);
  m_WebAudioGeneration = EM_ASM_INT({
    return typeof _audGeneration === 'number' ? _audGeneration : 0;
  });
  m_TerminationReported.store(false);
  m_StopErrorCode.store(0);
  m_StreamMediaContext = m_MediaOperationEpoch.Begin(nullptr);
  m_CurrentMediaListeners = nullptr;
  m_InitialSourceCloseLatch.Reset();
  m_SourceOpenLatch.Reset();
  m_AudioTrackOpenLatch.Reset();
  m_VideoTrackOpenLatch.Reset();
  m_PlayLatch.Reset();
  m_SourceCloseLatch.Reset();

  PostToJs("Setting the Host address to: " + host + ":" + std::to_string(httpPort));
  PostToJs("Setting the Video resolution to: " + width + "x" + height);
  PostToJs("Setting the Video frame rate to: " + fps + " FPS");
  PostToJs("Setting the Video bitrate to: " + bitrate + " Kbps");
  PostToJs("Configuring the remote input key.");
  PostToJs("Configuring the remote input key ID.");
  PostToJs("Setting the App version to: " + appversion);
  PostToJs("Setting the GFE version to: " + gfeversion);
  PostToJs("Setting the RTSP session URL to: " + rtspurl);
  PostToJs("Setting the Server codec mode support to: " + std::to_string(serverCodecModeSupport));
  PostToJs("Setting the Video frame pacing to: " + std::to_string(framePacing));
  PostToJs("Setting the Optimize game settings to: " + std::to_string(optimizeGames));
  PostToJs("Setting the Rumble feedback to: " + std::to_string(rumbleFeedback));
  PostToJs("Setting the Mouse emulation to: " + std::to_string(mouseEmulation));
  PostToJs("Setting the Flip A/B face buttons to: " + std::to_string(flipABfaceButtons));
  PostToJs("Setting the Flip X/Y face buttons to: " + std::to_string(flipXYfaceButtons));
  PostToJs("Setting the Audio backend to: " + audioBackend);
  PostToJs("Setting the Audio configuration to: " + audioConfig);
  PostToJs("Setting the Audio synchronization to: " + std::to_string(audioSync));
  PostToJs("Setting the Audio jitter buffer to: " + std::to_string(audioJitterMs) + " ms");
  PostToJs("Setting the Play host audio to: " + std::to_string(playHostAudio));
  PostToJs("Setting the Decrypt host audio to: " + std::to_string(decryptHostAudio));
  PostToJs("Setting the Video codec to: " + videoCodec);
  PostToJs("Setting the Video HDR mode to: " + std::to_string(hdrMode));
  PostToJs("Setting the Full color range to: " + std::to_string(fullRange));
  PostToJs("Setting the Game mode to: " + std::to_string(gameMode));
  PostToJs("Setting the Disable connection warnings to: " + std::to_string(disableWarnings));
  PostToJs("Setting the Performance statistics to: " + std::to_string(performanceStats));
  ClLogMessage("Experimental RFI recovery requested: %s\n", speculativeRfi ? "enabled" : "disabled");
  ClLogMessage("Build optimization: %s\n", MOONLIGHT_OPT_LEVEL_TEXT);

  // Populate the stream configuration
  LiInitializeStreamConfiguration(&m_StreamConfig);
  m_StreamConfig.width = stoi(width);
  m_StreamConfig.height = stoi(height);
  m_StreamConfig.fps = stoi(fps);
  m_StreamConfig.bitrate = stoi(bitrate); // kilobits per second
  m_StreamConfig.packetSize = 1392;
  m_StreamConfig.streamingRemotely = STREAM_CFG_AUTO;

  // Initialize the audio backend with default value
  m_AudioBackend = AudioBackend::Emss;
  // Handle setting of the audio backend based on the selected backend
  if (audioBackend == "EMSS") { // Elementary Media Stream Source
    // Apply the appropriate value for the EMSS backend
    m_AudioBackend = AudioBackend::Emss;
    PostToJs("Selecting the audio backend to: AUDIO_BACKEND_EMSS");
  } else if (audioBackend == "WebAudio") { // Web Audio
    // Apply the appropriate value for the Web Audio backend
    m_AudioBackend = AudioBackend::WebAudio;
    PostToJs("Selecting the audio backend to: AUDIO_BACKEND_WEB_AUDIO");
  } else if (audioBackend == "Disabled") { // No audio output
    // Apply the appropriate value when the audio output is disabled
    m_AudioBackend = AudioBackend::Disabled;
    PostToJs("Selecting the audio backend to: AUDIO_BACKEND_DISABLED");
  } else { // Unknown
    // Default case for unsupported audio backend selection
    ClLogMessage("Unsupported audio backend '%s' detected! Reverting to the default backend...\n", audioBackend.c_str());
    PostToJs("Selecting the fallback audio backend to: AUDIO_BACKEND_EMSS");
  }

  // Initialize the audio configuration with default value
  m_StreamConfig.audioConfiguration = 0;
  // Handle setting of audio configuration values ​​based on the selected audio
  if (audioConfig == "Stereo") { // Stereo
    // Apply the appropriate value for the Stereo audio
    m_StreamConfig.audioConfiguration |= AUDIO_CONFIGURATION_STEREO;
    PostToJs("Selecting the audio config to: AUDIO_CONFIGURATION_STEREO");
  } else if (audioConfig == "51Surround") { // 5.1 Surround
    // Apply the appropriate value for the 5.1 Surround audio
    m_StreamConfig.audioConfiguration |= AUDIO_CONFIGURATION_51_SURROUND;
    PostToJs("Selecting the audio config to: AUDIO_CONFIGURATION_51_SURROUND");
  } else if (audioConfig == "71Surround") { // 7.1 Surround
    // Apply the appropriate value for the 7.1 Surround audio
    m_StreamConfig.audioConfiguration |= AUDIO_CONFIGURATION_71_SURROUND;
    PostToJs("Selecting the audio config to: AUDIO_CONFIGURATION_71_SURROUND");
  } else { // Unknown
    // Default case for unsupported audio selection
    ClLogMessage("Unsupported audio config '%s' detected! Reverting to the default audio...\n", audioConfig.c_str());
  }
  // Handle fall back logic for audio configuration
  if (m_StreamConfig.audioConfiguration == 0) { // Unset
    // Fallback to Stereo if no audio was selected
    m_StreamConfig.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    PostToJs("Selecting the fallback audio config to: AUDIO_CONFIGURATION_STEREO");
  }
  // Store the audio configuration value from the stream configurations
  m_AudioConfig = m_StreamConfig.audioConfiguration;

  // Initialize the supported video format with default value
  m_StreamConfig.supportedVideoFormats = 0;
  // Handle setting of supported video format values ​​based on the selected codec
  if (videoCodec == "H264") { // H.264
    // Apply the appropriate value for the H.264 codec
    m_StreamConfig.supportedVideoFormats |= VIDEO_FORMAT_H264;
    PostToJs("Selecting the video format to: VIDEO_FORMAT_H264");
  } else if (videoCodec == "HEVC") { // HEVC
    // Apply the desired HDR or SDR profile ​for the HEVC codec based on the HDR toggle switch state
    m_StreamConfig.supportedVideoFormats |= hdrMode ? VIDEO_FORMAT_H265_MAIN10 : VIDEO_FORMAT_H265;
    PostToJs(hdrMode ? "Selecting the video format to: VIDEO_FORMAT_H265_MAIN10" : "Selecting the video format to: VIDEO_FORMAT_H265");
  } else if (videoCodec == "AV1") { // AV1
    // Apply the desired HDR or SDR profile ​for the AV1 codec based on the HDR toggle switch state
    m_StreamConfig.supportedVideoFormats |= hdrMode ? VIDEO_FORMAT_AV1_MAIN10 : VIDEO_FORMAT_AV1_MAIN8;
    PostToJs(hdrMode ? "Selecting the video format to: VIDEO_FORMAT_AV1_MAIN10" : "Selecting the video format to: VIDEO_FORMAT_AV1_MAIN8");
  } else { // Unknown
    // Default case for unsupported codec selection
    ClLogMessage("Unsupported video codec '%s' detected! Reverting to the default codec...\n", videoCodec.c_str());
  }
  // Handle fall back logic for supported video formats
  if (m_StreamConfig.supportedVideoFormats == 0) { // Unset
    // Fallback to H.264 if no codec was selected
    m_StreamConfig.supportedVideoFormats = VIDEO_FORMAT_H264;
    PostToJs("Selecting the fallback video format to: VIDEO_FORMAT_H264");
  }

  s_DrCallbacks.capabilities = decoderCapabilitiesWithOptionalRfi(
    CAPABILITY_SLICES_PER_FRAME(4),
    speculativeRfi,
    m_StreamConfig.supportedVideoFormats);
  ClLogMessage("Decoder renderer capabilities: 0x%X (RFI recovery %s)\n",
    s_DrCallbacks.capabilities,
    speculativeRfi ? "enabled" : "disabled");

  // Initialize the color range with default value
  m_StreamConfig.colorRange = 0;
  // Apply the desired color range ​based on the toggle switch state
  m_StreamConfig.colorRange |= fullRange ? COLOR_RANGE_FULL : COLOR_RANGE_LIMITED;

  // Apply encryption audio only when decrypt host audio is enabled, otherwise disable encryption
  m_StreamConfig.encryptionFlags = decryptHostAudio ? ENCFLG_AUDIO : ENCFLG_NONE;

  // Load the rikey and rikeyid into the stream configuration
  HexStringToBytes(rikey.c_str(), m_StreamConfig.remoteInputAesKey);
  int rikeyiv = htonl(stoi(rikeyid));
  memcpy(m_StreamConfig.remoteInputAesIv, &rikeyiv, sizeof(rikeyiv));

  // Manage gamepad input states based on selected settings
  HandleGamepadInputState(rumbleFeedback, mouseEmulation, flipABfaceButtons, flipXYfaceButtons);

  // Apply the desired latency mode ​based on the toggle switch state
  EmssLatencyMode selectedLatencyMode = gameMode ? EmssLatencyMode::kUltraLow : EmssLatencyMode::kLow;
  PostToJs(gameMode ? "Selecting the latency mode to: LATENCY_MODE_ULTRA_LOW" : "Selecting the latency mode to: LATENCY_MODE_LOW");
  // Create the media source with the selected latency and rendering modes
  m_Source = std::make_unique<samsung::wasm::ElementaryMediaStreamSource>(
    selectedLatencyMode,
    EmssRenderingMode::kMediaElement
  );
  m_StreamMediaContext = m_MediaOperationEpoch.Begin(m_Source.get());
  auto mediaListeners =
    std::make_unique<MediaCallbackListeners>(this, m_StreamMediaContext);
  m_CurrentMediaListeners = mediaListeners.get();
  // EMSS owns raw listener pointers and may dispatch callbacks after teardown.
  // Retain each immutable epoch-bound listener set for the instance lifetime.
  m_MediaCallbackListenerOwners.push_back(std::move(mediaListeners));

  // Store the parameters from the start message
  m_Host = host;
  m_HttpPort = httpPort;
  m_AppVersion = appversion;
  m_GfeVersion = gfeversion;
  m_RtspUrl = rtspurl;
  m_ServerCodecModeSupport = serverCodecModeSupport;
  m_FramePacingEnabled = framePacing;
  m_OptimizeGamesEnabled = optimizeGames;
  m_RumbleFeedbackEnabled = rumbleFeedback;
  m_MouseEmulationEnabled = mouseEmulation;
  m_FlipABfaceButtonsEnabled = flipABfaceButtons;
  m_FlipXYfaceButtonsEnabled = flipXYfaceButtons;
  m_AudioSyncEnabled = audioSync;
  m_AudioJitterMs = audioJitterMs;
  m_PlayHostAudioEnabled = playHostAudio;
  m_DecryptHostAudioEnabled = decryptHostAudio;
  m_HdrModeEnabled = hdrMode;
  m_FullRangeEnabled = fullRange;
  m_GameModeEnabled = gameMode;
  m_DisableWarningsEnabled = disableWarnings;
  m_PerformanceStatsEnabled.store(performanceStats);

  // Initialize the rendering surface before starting the connection
  bool teardownRequested = false;
  int teardownErrorCode = 0;
  if (InitializeRenderingSurface(m_StreamConfig.width, m_StreamConfig.height)) {
    // Start the worker thread to establish the connection
    const int connectionThreadResult =
      m_ConnectionThread.Create(MoonlightInstance::ConnectionThreadFunc, this);
    if (connectionThreadResult != 0) {
      ClLogMessage(
        "Failed to create the connection thread: %d\n",
        connectionThreadResult);
      teardownRequested = true;
      teardownErrorCode = connectionThreadResult;
    }
  } else {
    // Failed to initialize renderer
    teardownRequested = true;
  }

  startGuard.Release();
  if (teardownRequested) {
    StopConnection(teardownErrorCode);
  }

  return MessageResult::Resolve();
}

MessageResult MoonlightInstance::StopStream() {
  // Begin connection teardown
  StopConnection(0);

  return MessageResult::Resolve();
}

MessageResult MoonlightInstance::CancelRequest(int callbackId) {
  ClLogMessage("%s: Canceling HTTP callback ID %d\n", __func__, callbackId);
  m_HttpRequests.Cancel(callbackId);

  return MessageResult::Resolve();
}

void MoonlightInstance::STUN_private(int callbackId) {
  unsigned int wanAddr;
  char addrStr[128] = {};

  if (LiFindExternalAddressIP4("stun.moonlight-stream.org", 3478, &wanAddr) == 0) {
    inet_ntop(AF_INET, &wanAddr, addrStr, sizeof(addrStr));
    PostPromiseMessage(callbackId, "resolve", std::string(addrStr, strlen(addrStr)));
  } else {
    PostPromiseMessage(callbackId, "resolve", "");
  }
}

void MoonlightInstance::STUN(int callbackId) {
  if (!m_Dispatcher.post_job(
        std::bind(&MoonlightInstance::STUN_private, this, callbackId), false)) {
    PostPromiseMessage(
      callbackId, "reject", "Request dispatcher is unavailable.");
  }
}

void MoonlightInstance::Pair_private(
    int callbackId, std::string serverMajorVersion, std::string address,
    int httpPort, std::string randomNumber,
    std::shared_ptr<HTTP_REQUEST_CONTEXT> requestContext) {
  char* ppkstr = nullptr;
  int err = gs_pair(atoi(serverMajorVersion.c_str()), address.c_str(),
                    (unsigned short)httpPort, randomNumber.c_str(),
                    requestContext.get(), &ppkstr);

  ClLogMessage("Pair request for host address: %s:%d completed with result: %d\n",
               address.c_str(), httpPort, err);
  if (err == 0) {
    PostPromiseMessage(callbackId, "resolve", ppkstr);
    free(ppkstr);
  } else {
    PostPromiseMessage(callbackId, "reject", std::to_string(err));
  }
  m_HttpRequests.Remove(callbackId);
}

void MoonlightInstance::Pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber) {
  ClLogMessage("%s with host address: %s:%d\n", __func__, address.c_str(), httpPort);
  auto requestContext = m_HttpRequests.Create(callbackId, 3000, 0);
  if (!requestContext) {
    PostPromiseMessage(callbackId, "reject", "Duplicate HTTP callback ID.");
    return;
  }

  if (!PostHttpJob(
        "pair",
        [this, callbackId, serverMajorVersion, address, httpPort, randomNumber,
         requestContext]() {
          Pair_private(callbackId, serverMajorVersion, address, httpPort,
                       randomNumber, requestContext);
        })) {
    m_HttpRequests.Remove(callbackId);
    PostPromiseMessage(
      callbackId, "reject", "Request dispatcher is unavailable.");
  }
}

void MoonlightInstance::WakeOnLan(int callbackId, std::string macAddress) {
  if (!m_Dispatcher.post_job(
        std::bind(
          &MoonlightInstance::WakeOnLan_private, this, callbackId, macAddress),
        false)) {
    PostPromiseMessage(
      callbackId, "reject", "Request dispatcher is unavailable.");
  }
}

void MoonlightInstance::WakeOnLan_private(int callbackId, std::string macAddress) {
  unsigned char magicPacket[102];
  unsigned char mac[6];

  // Validate and parse the MAC address
  if (sscanf(macAddress.c_str(), "%hhx:%hhx:%hhx:%hhx:%hhx:%hhx", &mac[0], &mac[1], &mac[2], &mac[3], &mac[4], &mac[5]) != 6) {
    ClLogMessage("Invalid MAC address format: %s\n", macAddress.c_str());
    PostPromiseMessage(callbackId, "reject", "Invalid MAC address format");
    return;
  }

  // Check for invalid default MAC address (00:00:00:00:00:00)
  bool isZeroMac = true;
  for (int i = 0; i < 6; i++) {
    if (mac[i] != 0) {
      isZeroMac = false;
      break;
    }
  }
  if (isZeroMac) {
    ClLogMessage("Invalid MAC address: default zero MAC address not allowed: %s\n", macAddress.c_str());
    PostPromiseMessage(
      callbackId, "reject",
      "Invalid MAC address: default zero MAC address not allowed");
    return;
  }

  // Fill magic packet with the MAC address
  for (int i = 0; i < 6; i++) {
    magicPacket[i] = 0xFF;
  }
  for (int i = 1; i <= 16; i++) {
    memcpy(&magicPacket[i * 6], &mac, 6 * sizeof(unsigned char));
  }

  // Create UDP socket
  int udpSocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (udpSocket == -1) {
    ClLogMessage("Failed to create socket");
    PostPromiseMessage(callbackId, "reject", "Failed to create socket");
    return;
  }

  // Enable broadcasting
  int broadcast = 1;
  if (setsockopt(udpSocket, SOL_SOCKET, SO_BROADCAST, &broadcast, sizeof(broadcast)) == -1) {
    ClLogMessage("Failed to enable broadcast");
    close(udpSocket);
    PostPromiseMessage(callbackId, "reject", "Failed to enable broadcast");
    return;
  }

  // Set up destination address for the magic packet
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = INADDR_BROADCAST;
  addr.sin_port = htons(9); // Wake-on-LAN typically uses port 9

  bool sent = false;

  // Send the magic packet over IPv4
  if (sendto(udpSocket, magicPacket, sizeof(magicPacket), 0, (struct sockaddr*) &addr, sizeof(addr)) == -1) {
    ClLogMessage("Failed to send magic packet to MAC address: %s\n", macAddress.c_str());
  } else {
    ClLogMessage("Magic packet sent successfully to MAC address: %s\n", macAddress.c_str());
    sent = true;
  }

  // Close the IPv4 socket
  close(udpSocket);

  // Send the magic packet over IPv6
  int udp6Socket = socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP);
  if (udp6Socket != -1) {
    struct sockaddr_in6 addr6;
    memset(&addr6, 0, sizeof(addr6));
    addr6.sin6_family = AF_INET6;
    addr6.sin6_port = htons(9); // Wake-on-LAN typically uses port 9
    // ff02::1 is the link-local all-nodes multicast address
    inet_pton(AF_INET6, "ff02::1", &addr6.sin6_addr);

    if (sendto(udp6Socket, magicPacket, sizeof(magicPacket), 0, (struct sockaddr*) &addr6, sizeof(addr6)) == -1) {
      ClLogMessage("Failed to send IPv6 magic packet to MAC address: %s\n", macAddress.c_str());
    } else {
      ClLogMessage("IPv6 Magic packet sent successfully to MAC address: %s\n", macAddress.c_str());
      sent = true;
    }
    close(udp6Socket);
  }

  if (!sent) {
    PostPromiseMessage(
      callbackId, "reject",
      "Failed to send magic packet to MAC address: " + macAddress);
    return;
  }

  PostPromiseMessage(callbackId, "resolve", "Magic packet sent successfully to MAC address: " + macAddress);
}

bool MoonlightInstance::Init(uint32_t argc, const char* argn[], const char* argv[]) {
  g_Instance = this;
  return true;
}

int main(int argc, char** argv) {
  g_Instance = new MoonlightInstance();

  emscripten_set_keyup_callback(kCanvasName, NULL, EM_TRUE, handleKeyUp);
  emscripten_set_keydown_callback(kCanvasName, NULL, EM_TRUE, handleKeyDown);
  emscripten_set_mousedown_callback(kCanvasName, NULL, EM_TRUE, handleMouseDown);
  emscripten_set_mouseup_callback(kCanvasName, NULL, EM_TRUE, handleMouseUp);
  emscripten_set_mousemove_callback(kCanvasName, NULL, EM_TRUE, handleMouseMove);
  emscripten_set_wheel_callback(kCanvasName, NULL, EM_TRUE, handleWheel);

  // As we want to setup callbacks on DOM document and
  // emscripten_set_pointerlock... calls use document.querySelector
  // method, passing first argument to it, I've workaround for it
  // When passing address 0x1, js glue code replace it with document object
  static const char* kDocument = reinterpret_cast<const char*>(0x1);
  emscripten_set_pointerlockchange_callback(kDocument, NULL, EM_TRUE, handlePointerLockChange);
  emscripten_set_pointerlockerror_callback(kDocument, NULL, EM_TRUE, handlePointerLockError);
  EM_ASM(Module['noExitRuntime'] = true);
  unsigned char buffer[128];
  int rc = RAND_bytes(buffer, sizeof(buffer));

  if (rc != 1) {
    std::cout << "RAND_bytes failed\n";
  }
  RAND_seed(buffer, 128);
}

MessageResult startStream(std::string host, int httpPort, std::string width, std::string height, std::string fps, std::string bitrate,
  std::string rikey, std::string rikeyid, std::string appversion, std::string gfeversion, std::string rtspurl, int serverCodecModeSupport,
  bool framePacing, bool optimizeGames, bool rumbleFeedback, bool mouseEmulation, bool flipABfaceButtons, bool flipXYfaceButtons,
  std::string audioBackend, std::string audioConfig, bool audioSync, int audioJitterMs, bool playHostAudio, bool decryptHostAudio,
  std::string videoCodec, bool hdrMode, bool fullRange, bool gameMode, bool disableWarnings, bool performanceStats, bool speculativeRfi) {
  PostToJs("Starting the streaming session...");
  return g_Instance->StartStream(host, httpPort, width, height, fps, bitrate, rikey, rikeyid, appversion, gfeversion, rtspurl, serverCodecModeSupport,
  framePacing, optimizeGames, rumbleFeedback, mouseEmulation, flipABfaceButtons, flipXYfaceButtons, audioBackend, audioConfig,
  audioSync, audioJitterMs, playHostAudio, decryptHostAudio, videoCodec, hdrMode, fullRange, gameMode, disableWarnings, performanceStats,
  speculativeRfi);
}

MessageResult stopStream() {
  PostToJs("Stopping the streaming session...");
  return g_Instance->StopStream();
}

MessageResult cancelRequest(int callbackId) {
  return g_Instance->CancelRequest(callbackId);
}

void toggleStats() {
  g_Instance->TogglePerformanceStats();
}

void stun(int callbackId) {
  g_Instance->STUN(callbackId);
}

void pair(int callbackId, std::string serverMajorVersion, std::string address, int httpPort, std::string randomNumber, std::string uniqueId) {
  if (g_UniqueId) {
    free(g_UniqueId);
  }
  g_UniqueId = strdup(uniqueId.c_str());
  g_Instance->Pair(callbackId, serverMajorVersion, address, httpPort, randomNumber);
}

void wakeOnLan(int callbackId, std::string macAddress) {
  g_Instance->WakeOnLan(callbackId, macAddress);
}

void PostToJs(std::string msg) {
  MAIN_THREAD_EM_ASM({
    const msg = UTF8ToString($0);
    handleMessage(msg);
  }, msg.c_str());
}

void PostToJsAsync(std::string msg) {
  MAIN_THREAD_ASYNC_EM_ASM({
    const msg = UTF8ToString($0);
    handleMessage(msg);
  }, msg.c_str());
}

void PostPromiseMessage(int callbackId, const std::string& type, const std::string& response) {
  MAIN_THREAD_EM_ASM({
    const type = UTF8ToString($1);
    const response = UTF8ToString($2);
    handlePromiseMessage($0, type, response);
  }, callbackId, type.c_str(), response.c_str());
}

void PostPromiseMessage(int callbackId, const std::string& type, const std::vector<uint8_t>& response) {
  MAIN_THREAD_EM_ASM({
    const type = UTF8ToString($1);
    const response = HEAPU8.slice($2, $2 + $3);
    handlePromiseMessage($0, type, response);
  }, callbackId, type.c_str(), response.data(), response.size());
}

EMSCRIPTEN_BINDINGS(handle_message) {
  emscripten::value_object<MessageResult>("MessageResult").field("type", &MessageResult::type).field("ret", &MessageResult::ret);
  emscripten::function("startStream", &startStream);
  emscripten::function("stopStream", &stopStream);
  emscripten::function("cancelRequest", &cancelRequest);
  emscripten::function("toggleStats", &toggleStats);
  emscripten::function("drainDiagnosticLogs", &DrainDiagnosticLogs);
  emscripten::function("setDiagnosticLogEnabled", &SetDiagnosticLogEnabled);
  emscripten::function("stun", &stun);
  emscripten::function("pair", &pair);
  emscripten::function("wakeOnLan", &wakeOnLan);
}
