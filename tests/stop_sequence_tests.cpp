#include "wasm/stop_sequence.hpp"

#include <cassert>
#include <string>
#include <vector>

namespace {

struct Recorder {
  std::vector<std::string> calls;
  int connectionJoinResult{0};
  int inputJoinResult{0};

  StopSequence Build() {
    StopSequence sequence;
    sequence.joinConnectionThread = [this] { calls.push_back("joinConnection"); return connectionJoinResult; };
    sequence.releaseRemoteInputs = [this] { calls.push_back("releaseInputs"); };
    sequence.joinInputThread = [this] { calls.push_back("joinInput"); return inputJoinResult; };
    sequence.stopConnection = [this] { calls.push_back("stopConnection"); };
    sequence.closeMediaSource = [this] { calls.push_back("closeMedia"); };
    sequence.onJoinFailure = [this](const char* thread, int result) {
      calls.push_back(std::string("joinFailed:") + thread + ":" + std::to_string(result));
    };
    sequence.notifyStopped = [this] { calls.push_back("notify"); };
    sequence.markIdle = [this] { calls.push_back("idle"); };
    return sequence;
  }
};

}  // namespace

int main() {
  // The orderly case keeps the established order: threads first, then the library, then the media source.
  {
    Recorder recorder;
    RunStopSequence(recorder.Build());
    const std::vector<std::string> expected = {
      "joinConnection", "releaseInputs", "joinInput", "stopConnection", "closeMedia", "notify", "idle"};
    assert(recorder.calls == expected);
  }

  // The connection thread cannot be joined. LiStopConnection and the media source must not be touched while
  // it may still be inside LiStartConnection, but the interface must still learn that the stream ended and
  // the lifecycle must return to idle, otherwise every later start is refused until the application restarts.
  {
    Recorder recorder;
    recorder.connectionJoinResult = 22;
    RunStopSequence(recorder.Build());
    const std::vector<std::string> expected = {"joinConnection", "joinFailed:connection:22", "notify", "idle"};
    assert(recorder.calls == expected);
  }

  // The input thread cannot be joined. The connection thread is gone, so the library and the media source are
  // still released; leaving them running would break the next stream.
  {
    Recorder recorder;
    recorder.inputJoinResult = 35;
    RunStopSequence(recorder.Build());
    const std::vector<std::string> expected = {
      "joinConnection", "releaseInputs", "joinInput", "joinFailed:input:35",
      "stopConnection", "closeMedia", "notify", "idle"};
    assert(recorder.calls == expected);
  }

  // Notifying and returning to idle happen exactly once and last, whatever failed.
  for (int connectionResult : {0, 1}) {
    for (int inputResult : {0, 1}) {
      Recorder recorder;
      recorder.connectionJoinResult = connectionResult;
      recorder.inputJoinResult = inputResult;
      RunStopSequence(recorder.Build());
      int notifications = 0;
      int idles = 0;
      for (const auto& call : recorder.calls) {
        notifications += call == "notify";
        idles += call == "idle";
      }
      assert(notifications == 1 && idles == 1);
      assert(recorder.calls[recorder.calls.size() - 2] == "notify");
      assert(recorder.calls.back() == "idle");
    }
  }

  return 0;
}
