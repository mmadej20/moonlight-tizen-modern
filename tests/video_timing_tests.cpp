#include "wasm/video_timing.hpp"

#include <algorithm>
#include <cassert>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <vector>

using namespace std::chrono_literals;

static void AssertNear(double actual, double expected) {
  assert(std::fabs(actual - expected) < 0.000001);
}

// The pacing thread as the player runs it: it takes the frames from the queue one at a time, holds each until the anchor says so, and
// appends it. A frame that arrives while another is held or appended waits in the queue.
struct SimFrame {
  int64_t ptsUs;
  int64_t arrivalUs;
  int64_t appendUs;
};

static const int64_t kSimIntervalUs = 16667;  // 60 FPS
static const int64_t kSimNetworkUs = 5000;    // the delay of the network without jitter

struct SimStream {
  std::vector<SimFrame> frames;
  int64_t hostUs = 0;
  uint32_t seed = 4242;

  int64_t Jitter(int64_t maxUs) {
    seed = seed * 1664525u + 1013904223u;
    return static_cast<int64_t>((seed >> 8) % static_cast<uint32_t>(maxUs + 1));
  }

  // A frame that the host captured now and sent at once
  void Real(int64_t afterUs, int64_t lateUs = 0, int64_t appendUs = 1000) {
    hostUs += afterUs;
    frames.push_back({hostUs, hostUs + kSimNetworkUs + Jitter(3000) + lateUs, appendUs});
  }

  // A frame that the host repeats while the picture is still: its timestamp is about the time that the frame before it was sent
  void Repeated(int64_t afterUs) {
    const int64_t previousSentUs = hostUs;
    hostUs += afterUs;
    frames.push_back({previousSentUs + 2000, hostUs + kSimNetworkUs + Jitter(3000), 1000});
  }
};

// Returns how long every frame waited between its arrival and its append. asThePlayerDid: the offset is taken when the pacing thread
// gets the frame and every frame has a vote, which is what the player did before.
static std::vector<int64_t> RunPacer(const std::vector<SimFrame>& frames, bool asThePlayerDid) {
  PlayoutAnchor anchor(PlayoutMaxBufferUs(kSimIntervalUs), kSimIntervalUs);
  std::vector<int64_t> holds;
  int64_t pacerFreeUs = INT64_MIN;
  for (size_t i = 0; i < frames.size(); ++i) {
    const SimFrame& frame = frames[i];
    const int64_t dequeueUs = std::max(frame.arrivalUs, pacerFreeUs);
    int64_t anchorUs;
    if (asThePlayerDid) {
      anchorUs = anchor.Observe(dequeueUs - frame.ptsUs);
    } else if (i == 0) {
      anchorUs = anchor.Observe(frame.arrivalUs - frame.ptsUs);
    } else {
      anchorUs = anchor.Observe(
        frame.arrivalUs - frame.ptsUs,
        frame.ptsUs - frames[i - 1].ptsUs,
        frame.arrivalUs - frames[i - 1].arrivalUs);
    }
    const int64_t submitUs = std::max(dequeueUs, anchorUs + frame.ptsUs);
    pacerFreeUs = submitUs + frame.appendUs;
    holds.push_back(submitUs - frame.arrivalUs);
  }
  return holds;
}

static int64_t MeanHold(const std::vector<int64_t>& holds, size_t from, size_t to) {
  int64_t total = 0;
  for (size_t i = from; i < to; ++i) total += holds[i];
  return total / static_cast<int64_t>(to - from);
}

static int64_t WorstHold(const std::vector<int64_t>& holds, size_t from, size_t to) {
  int64_t worst = 0;
  for (size_t i = from; i < to; ++i) worst = std::max(worst, holds[i]);
  return worst;
}

static void PacerSimulationTests() {
  {
    // A steady stream: both ways hold the frames for the jitter only
    SimStream stream;
    for (int i = 0; i < 1200; ++i) stream.Real(kSimIntervalUs);
    assert(MeanHold(RunPacer(stream.frames, false), 300, 1200) < 4000);
    assert(MeanHold(RunPacer(stream.frames, true), 300, 1200) < 4000);
  }
  {
    // The TV was busy for a moment (the stream menu opened) and twelve appends took 40 ms each. The frames behind them waited in the
    // queue, which says nothing about the network: the hold must be back to the jitter as soon as the queue is empty. It used to stay
    // up for seconds, because the wait in the queue counted as lateness and the higher anchor made the next frames wait too.
    SimStream stream;
    for (int i = 0; i < 600; ++i) stream.Real(kSimIntervalUs);
    for (int i = 0; i < 12; ++i) stream.Real(kSimIntervalUs, 0, 40000);
    for (int i = 0; i < 900; ++i) stream.Real(kSimIntervalUs);
    const auto now = RunPacer(stream.frames, false);
    const auto before = RunPacer(stream.frames, true);
    assert(MeanHold(now, 660, 900) < 4000);
    assert(WorstHold(now, 660, 1500) < 6000);
    assert(MeanHold(before, 660, 900) > 15000);  // what the log of the TV showed
  }
  {
    // A still picture for a second and a half (a menu): the host repeats the frame every 55 ms. The move that follows must not start
    // late: the repeated frames only look late.
    SimStream stream;
    for (int i = 0; i < 600; ++i) stream.Real(kSimIntervalUs);
    for (int i = 0; i < 27; ++i) stream.Repeated(55000);
    const size_t firstMove = stream.frames.size();
    for (int i = 0; i < 600; ++i) stream.Real(kSimIntervalUs);
    const auto now = RunPacer(stream.frames, false);
    const auto before = RunPacer(stream.frames, true);
    assert(WorstHold(now, firstMove, firstMove + 600) < 6000);
    assert(MeanHold(before, firstMove + 30, firstMove + 110) > 25000);
  }
  {
    // A still picture for half a minute: the window holds nothing but repeated frames. The first frame of the move is shown at once,
    // and so are the ones after it.
    SimStream stream;
    for (int i = 0; i < 300; ++i) stream.Real(kSimIntervalUs);
    for (int i = 0; i < 550; ++i) stream.Repeated(55000);
    const size_t firstMove = stream.frames.size();
    stream.Real(20000);
    for (int i = 0; i < 300; ++i) stream.Real(kSimIntervalUs);
    const auto now = RunPacer(stream.frames, false);
    assert(now[firstMove] < 2000);
    assert(WorstHold(now, firstMove, firstMove + 300) < 6000);
  }
  {
    // A picture that changes now and then (a cursor that blinks): a real frame, then repeated ones. The real frames are not held for
    // the repeated ones.
    SimStream stream;
    for (int i = 0; i < 300; ++i) stream.Real(kSimIntervalUs);
    std::vector<size_t> realFrames;
    for (int round = 0; round < 60; ++round) {
      realFrames.push_back(stream.frames.size());
      stream.Real(30000);
      for (int i = 0; i < 8; ++i) stream.Repeated(55000);
    }
    const auto now = RunPacer(stream.frames, false);
    for (size_t index : realFrames) assert(now[index] < 6000);
  }
  {
    // One stall of the network of 150 ms: nine frames arrive together. That is one event, and the frames after it are not held for it.
    SimStream stream;
    for (int i = 0; i < 600; ++i) stream.Real(kSimIntervalUs);
    for (int i = 0; i < 9; ++i) stream.Real(kSimIntervalUs, 150000 - i * kSimIntervalUs);
    for (int i = 0; i < 600; ++i) stream.Real(kSimIntervalUs);
    const auto now = RunPacer(stream.frames, false);
    const auto before = RunPacer(stream.frames, true);
    assert(WorstHold(now, 620, 1200) < 6000);
    assert(MeanHold(before, 660, 720) > 20000);
  }
  {
    // Lateness that keeps coming is jitter: every fourth frame is 20 ms late. The anchor covers it, so the frames are shown evenly
    // (the late ones on time, the others held for them), as before.
    SimStream stream;
    for (int i = 0; i < 1500; ++i) stream.Real(kSimIntervalUs, i % 4 == 3 ? 20000 : 0);
    const auto now = RunPacer(stream.frames, false);
    int onTime = 0;
    int counted = 0;
    for (size_t i = 400; i < now.size(); ++i) {
      if (i % 4 != 3) {
        ++counted;
        if (now[i] > 15000 && now[i] < 24000) ++onTime;
      } else {
        assert(now[i] < 4000);
      }
    }
    assert(onTime * 100 >= counted * 95);
  }
  {
    // The delay of the network goes up by 40 ms and stays there, at the full pace: the anchor follows, and nothing is held for more
    // than the cap on the way
    SimStream stream;
    for (int i = 0; i < 600; ++i) stream.Real(kSimIntervalUs);
    for (int i = 0; i < 900; ++i) stream.Real(kSimIntervalUs, 40000);
    const auto now = RunPacer(stream.frames, false);
    assert(WorstHold(now, 0, now.size()) <= 50000 + 1000);
    assert(MeanHold(now, 1000, 1500) < 4000);
  }
  {
    // A game at 30 FPS on a stream of 60: every frame is slower than the pace of the stream. They still have a vote while they are
    // not more than a frame interval late, so their jitter (up to 8 ms here) is smoothed
    SimStream stream;
    for (int i = 0; i < 900; ++i) stream.Real(2 * kSimIntervalUs, stream.Jitter(8000));
    const auto now = RunPacer(stream.frames, false);
    assert(MeanHold(now, 300, 900) > 2000);
    assert(WorstHold(now, 300, 900) <= 12000);
  }
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

  PacerSimulationTests();
}
