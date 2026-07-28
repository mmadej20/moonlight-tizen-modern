#include <cassert>
#include <string>

#include "wasm/media_track_diagnostics.hpp"

namespace {

void TestCloseReasonNames() {
  assert(std::string(MediaTrackCloseReasonName(0)) == "kSourceClosed");
  assert(std::string(MediaTrackCloseReasonName(1)) == "kSourceError");
  assert(std::string(MediaTrackCloseReasonName(2)) == "kSourceDetached");
  assert(std::string(MediaTrackCloseReasonName(3)) == "kSourceSuspended");
  assert(std::string(MediaTrackCloseReasonName(4)) == "kTrackDisabled");
  assert(std::string(MediaTrackCloseReasonName(5)) == "kTrackEnded");
  assert(std::string(MediaTrackCloseReasonName(6)) == "kTrackSeeking");
  assert(std::string(MediaTrackCloseReasonName(7)) == "kUnknown");
  assert(std::string(MediaTrackCloseReasonName(99)) == "unrecognized");
}

void TestOpenFormatting() {
  assert(
    FormatMediaTrackOpen("AUDIO", 4, true, 5, 0) ==
    "AUDIO track open storedSession=4 currentSession=5"
  );
  assert(
    FormatMediaTrackOpen("VIDEO", 8, false, 0, 3) ==
    "VIDEO track open storedSession=8 currentSessionError=3"
  );
}

void TestCloseFormatting() {
  assert(
    FormatMediaTrackClosed("AUDIO", 3, 4) ==
    "AUDIO track closed reason=kSourceSuspended(3) storedSession=4"
  );
  assert(
    FormatMediaTrackClosed("VIDEO", 42, 9) ==
    "VIDEO track closed reason=unrecognized(42) storedSession=9"
  );
}

void TestSessionChangeFormatting() {
  assert(
    FormatMediaTrackSessionChanged("AUDIO", 4, 5) ==
    "AUDIO session changed old=4 new=5"
  );
  assert(
    FormatMediaTrackSessionChanged("VIDEO", 10, 11) ==
    "VIDEO session changed old=10 new=11"
  );
}

}  // namespace

int main() {
  TestCloseReasonNames();
  TestOpenFormatting();
  TestCloseFormatting();
  TestSessionChangeFormatting();
  return 0;
}
