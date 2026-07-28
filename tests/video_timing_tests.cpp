#include "wasm/video_timing.hpp"

#include <cassert>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>

using namespace std::chrono_literals;

static void AssertNear(double actual, double expected) {
  assert(std::fabs(actual - expected) < 0.000001);
}

int main() {
  VideoTimestampState state{};
  AssertNear(UpdatePresentationTimestamp(1000, state, 250).seconds, 0.0);
  AssertNear(UpdatePresentationTimestamp(1016, state, 250).seconds, 0.016);
  AssertNear(UpdatePresentationTimestamp(1050, state, 250).seconds, 0.050);
  AssertNear(UpdatePresentationTimestamp(1049, state, 250).seconds, 0.050);
  AssertNear(UpdatePresentationTimestamp(1066, state, 250).seconds, 0.066);

  VideoTimestampState wrapping{};
  AssertNear(UpdatePresentationTimestamp(UINT32_MAX - 15, wrapping, 250).seconds, 0.0);
  AssertNear(UpdatePresentationTimestamp(16, wrapping, 250).seconds, 0.032);

  VideoTimestampState committed{};
  AssertNear(UpdatePresentationTimestamp(2000, committed, 250).seconds, 0.0);
  auto candidate = committed;
  AssertNear(UpdatePresentationTimestamp(2033, candidate, 250).seconds, 0.033);
  AssertNear(UpdatePresentationTimestamp(2016, committed, 250).seconds, 0.016);

  VideoTimestampState pacingReset{};
  auto first = UpdatePresentationTimestamp(1000, pacingReset, 250);
  assert(first.resetPacing && first.seconds == 0.0);
  auto normal = UpdatePresentationTimestamp(1016, pacingReset, 250);
  assert(!normal.resetPacing);
  auto jump = UpdatePresentationTimestamp(1400, pacingReset, 250);
  assert(jump.resetPacing);
  AssertNear(jump.seconds, 0.400);
  auto backwards = UpdatePresentationTimestamp(1300, pacingReset, 250);
  assert(!backwards.resetPacing);
  AssertNear(backwards.seconds, 0.400);
  auto afterBackwards = UpdatePresentationTimestamp(1416, pacingReset, 250);
  assert(!afterBackwards.resetPacing);
  AssertNear(afterBackwards.seconds, 0.416);

  VideoTimestampState threshold{};
  assert(UpdatePresentationTimestamp(1000, threshold, 250).resetPacing);
  auto exactThreshold = UpdatePresentationTimestamp(1250, threshold, 250);
  assert(!exactThreshold.resetPacing);
  AssertNear(exactThreshold.seconds, 0.250);
  auto overThreshold = UpdatePresentationTimestamp(1501, threshold, 250);
  assert(overThreshold.resetPacing);
  AssertNear(overThreshold.seconds, 0.501);

  VideoTimestampState restarted{};
  AssertNear(UpdatePresentationTimestamp(5000, restarted, 250).seconds, 0.0);
  AssertNear(UpdatePresentationTimestamp(5016, restarted, 250).seconds, 0.016);
  auto restart = UpdatePresentationTimestamp(1000, restarted, 250);
  assert(restart.resetPacing);
  AssertNear(restart.seconds, 0.016);
  auto afterRestart = UpdatePresentationTimestamp(1016, restarted, 250);
  assert(!afterRestart.resetPacing);
  AssertNear(afterRestart.seconds, 0.032);

  AdaptiveSpinWindow adaptive(200us, 50us, 300us, 0.25);
  adaptive.ObserveOvershoot(400us);
  assert(adaptive.value() == 250us);
  adaptive.ObserveOvershoot(1000us);
  assert(adaptive.value() == 300us);
  for (int i = 0; i < 20; ++i) adaptive.ObserveOvershoot(0us);
  assert(adaptive.value() >= 50us && adaptive.value() < 200us);

  AdaptiveSpinWindow rounded(200us, 50us, 300us, 0.25);
  rounded.ObserveOvershoot(202us);
  assert(rounded.value() == 201us);

  std::atomic<bool> cancelled{true};
  bool appended = false;
  bool committedState = false;
  auto cancelledBeforeAppend = AppendAndCommitPacingState(
    cancelled,
    [&] {
      appended = true;
      return true;
    },
    [&] { committedState = true; }
  );
  assert(cancelledBeforeAppend == PacingCommitOutcome::Cancelled);
  assert(!appended && !committedState);

  cancelled.store(false);
  auto cancelledAfterAppend = AppendAndCommitPacingState(
    cancelled,
    [&] {
      appended = true;
      cancelled.store(true);
      return true;
    },
    [&] { committedState = true; }
  );
  assert(cancelledAfterAppend == PacingCommitOutcome::Cancelled);
  assert(appended && !committedState);

  cancelled.store(false);
  appended = false;
  auto appendFailed = AppendAndCommitPacingState(
    cancelled,
    [&] {
      appended = true;
      return false;
    },
    [&] { committedState = true; }
  );
  assert(appendFailed == PacingCommitOutcome::AppendFailed);
  assert(appended && !committedState);

  appended = false;
  auto commitResult = AppendAndCommitPacingState(
    cancelled,
    [&] {
      appended = true;
      return true;
    },
    [&] { committedState = true; }
  );
  assert(commitResult == PacingCommitOutcome::Committed);
  assert(appended && committedState);

  auto noWait = CalculatePacingWait(-1us, 500us);
  assert(noWait.sleep == 0us && noWait.spin == 0us);

  auto spinOnly = CalculatePacingWait(300us, 500us);
  assert(spinOnly.sleep == 0us && spinOnly.spin == 300us);

  auto hybrid = CalculatePacingWait(2500us, 500us);
  assert(hybrid.sleep == 2000us && hybrid.spin == 500us);
}
