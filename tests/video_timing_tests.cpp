#include "wasm/video_timing.hpp"

#include <algorithm>
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

  // How long a frame may be held for the sake of smooth pacing: three frame intervals, between 20 and 50 ms
  assert(PlayoutMaxBufferUs(33333) == 50000);  // 30 FPS
  assert(PlayoutMaxBufferUs(16667) == 50000);  // 60 FPS (3 x 16.667 ms is 50.001 ms)
  assert(PlayoutMaxBufferUs(8333) == 24999);   // 120 FPS
  assert(PlayoutMaxBufferUs(6944) == 20832);   // 144 FPS
  assert(PlayoutMaxBufferUs(4167) == 20000);   // 240 FPS
  assert(PlayoutMaxBufferUs(0) == 20000);

  // The playout anchor: the offset (arrival minus presentation timestamp) at which presentation time zero plays. It follows the frames
  // that arrive fastest, plus the jitter that nearly all the frames show, and never holds a frame longer than the cap.
  {
    // A steady network: nothing is held
    PlayoutAnchor anchor(50000);
    for (int i = 0; i < 300; ++i) {
      assert(anchor.Observe(12345) == 12345);
      assert(anchor.BufferUs() == 0);
    }
  }
  {
    // The first frame arrived late (a stall, a big first frame): that must not become the delay of the whole stream
    PlayoutAnchor anchor(50000);
    assert(anchor.Observe(136000) == 136000);  // the first frame is shown at once, as before
    assert(anchor.Observe(0) == 0);            // the next one shows that frames do not take so long: the anchor follows at once
    for (int i = 0; i < 200; ++i) {
      assert(anchor.Observe(0) == 0);
    }
  }
  {
    // A late frame among the first few is not trusted: the middle of a few is, once there are three
    PlayoutAnchor anchor(50000);
    anchor.Observe(0);
    anchor.Observe(0);
    assert(anchor.Observe(80000) == 0);
  }
  {
    // Jitter of up to 10 ms: the anchor settles near the 95th percentile, so that 19 frames of 20 are smooth and none is held for more
    // than the jitter
    PlayoutAnchor anchor(50000);
    uint32_t seed = 12345;
    int64_t lowestSeen = INT64_MAX;
    for (int i = 0; i < 3000; ++i) {
      seed = seed * 1664525u + 1013904223u;
      const int64_t offset = 100000 + static_cast<int64_t>((seed >> 8) % 10001);
      const int64_t at = anchor.Observe(offset);
      if (i > 300) {
        lowestSeen = std::min(lowestSeen, at);
        assert(at - offset <= 10000);  // the hold of this frame
        assert(at >= 100000 + 8000 && at <= 100000 + 10000);
        assert(anchor.BufferUs() >= 8000 && anchor.BufferUs() <= 10000);
      }
    }
  }
  {
    // A stall of ten frames of +136 ms after a steady stretch: the anchor never goes beyond the lowest offset plus the cap, never rises
    // faster than 1 ms a frame, and is back near the steady offset once the stall has left the window
    PlayoutAnchor anchor(50000);
    uint32_t seed = 7;
    int64_t previous = 0;
    int64_t highest = 0;
    auto steady = [&] {
      seed = seed * 1664525u + 1013904223u;
      return static_cast<int64_t>((seed >> 8) % 2001);  // 0 to 2 ms
    };
    for (int i = 0; i < 400; ++i) previous = anchor.Observe(steady());
    for (int i = 0; i < 10; ++i) {
      const int64_t at = anchor.Observe(136000 + steady());
      assert(at - previous <= PlayoutAnchor::kMaxRiseUsPerFrame);
      highest = std::max(highest, at);
      previous = at;
    }
    for (int i = 0; i < 400; ++i) {
      const int64_t at = anchor.Observe(steady());
      assert(at - previous <= PlayoutAnchor::kMaxRiseUsPerFrame);
      highest = std::max(highest, at);
      previous = at;
      if (i >= static_cast<int>(PlayoutAnchor::kWindowFrames) + 5) {
        assert(at <= 3000);
      }
    }
    assert(highest <= 52000);
    assert(highest >= 2500);  // the stall did raise it, within the cap
  }
  {
    // A smaller cap is respected, and so is a rise in the base delay of the network (the frames are not all early any more)
    PlayoutAnchor anchor(20000);
    for (int i = 0; i < 300; ++i) anchor.Observe(0);
    int64_t at = 0;
    for (int i = 0; i < 400; ++i) {
      at = anchor.Observe(90000);
      assert(at <= 90000);
      assert(anchor.BufferUs() <= 20000);
    }
    // The window now holds only the new base delay, and the anchor has followed it
    assert(at == 90000);
  }
  {
    // What the user saw: the first frame arrived 136 ms late (a stall of the network), then a steady Wi-Fi with up to 8 ms of jitter. The
    // old anchor (the first frame, for good) held every later frame in the queue for about 130 ms; the new one holds them for the
    // jitter only.
    PlayoutAnchor anchor(PlayoutMaxBufferUs(16667));
    uint32_t seed = 99;
    const int64_t firstOffset = 136000 + 5000;
    int64_t oldHoldTotal = 0;
    int64_t newHoldTotal = 0;
    int64_t newHoldWorst = 0;
    int frames = 0;
    anchor.Observe(firstOffset);
    for (int i = 0; i < 3000; ++i) {
      seed = seed * 1664525u + 1013904223u;
      const int64_t offset = 5000 + static_cast<int64_t>((seed >> 8) % 8001);
      const int64_t anchorOffset = anchor.Observe(offset);
      oldHoldTotal += std::max<int64_t>(0, firstOffset - offset);
      const int64_t newHold = std::max<int64_t>(0, anchorOffset - offset);
      newHoldTotal += newHold;
      newHoldWorst = std::max(newHoldWorst, newHold);
      ++frames;
    }
    assert(oldHoldTotal / frames > 128000);
    assert(newHoldTotal / frames < 6000);
    assert(newHoldWorst <= 8000 + 1000);
  }
  {
    // The pacer works on a copy and commits it only when the frame was appended
    PlayoutAnchor committed(50000);
    committed.Observe(1000);
    committed.Observe(2000);
    PlayoutAnchor candidate = committed;
    candidate.Observe(500000);
    candidate.Observe(500000);
    PlayoutAnchor again = committed;
    assert(committed.Observe(1500) == again.Observe(1500));
  }
  {
    // A new timeline (the first frame, a jump of the timestamps backwards) starts over
    PlayoutAnchor anchor(50000);
    for (int i = 0; i < 50; ++i) anchor.Observe(5000 + (i % 7) * 1000);
    anchor.Reset();
    assert(anchor.Observe(777777) == 777777);
    assert(anchor.BufferUs() == 0);
  }
}
