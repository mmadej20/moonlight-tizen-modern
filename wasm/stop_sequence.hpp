#pragma once

#include <functional>

// The steps that tear a stream down, in the order they must run. Keeping the order and the failure
// handling here, apart from the Emscripten calls, makes the sequence testable on the host.
//
// Whatever fails, the interface is told that the stream ended and the lifecycle returns to idle.
// A teardown that gave up halfway used to leave the lifecycle in "stopping" for good, so every later
// start was refused as a wrong state and only restarting the application helped.
struct StopSequence {
  std::function<int()> joinConnectionThread;
  std::function<void()> releaseRemoteInputs;
  std::function<int()> joinInputThread;
  std::function<void()> stopConnection;
  std::function<void()> closeMediaSource;
  std::function<void(const char* thread, int result)> onJoinFailure;
  std::function<void()> notifyStopped;
  std::function<void()> markIdle;
};

inline void RunStopSequence(const StopSequence& steps) {
  // LiStopConnection must not run during LiStartConnection, and the media source may still be in
  // use by the connection thread, so when that thread cannot be joined neither is touched.
  const int connectionResult = steps.joinConnectionThread();
  if (connectionResult != 0) {
    steps.onJoinFailure("connection", connectionResult);
  } else {
    steps.releaseRemoteInputs();

    // Once the connection thread is gone the library and the media source can be released safely,
    // even if the input thread is stuck. Leaving them running would break the next stream.
    const int inputResult = steps.joinInputThread();
    if (inputResult != 0) {
      steps.onJoinFailure("input", inputResult);
    }

    steps.stopConnection();
    steps.closeMediaSource();
  }

  steps.notifyStopped();
  steps.markIdle();
}
