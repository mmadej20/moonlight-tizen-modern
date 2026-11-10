#ifndef MOONLIGHT_VIDEO_TIMING_HPP
#define MOONLIGHT_VIDEO_TIMING_HPP

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstddef>

struct VideoTimestampState {
  bool initialized = false;
  uint32_t lastRawTimestampMs = 0;
  uint64_t elapsedTimestampMs = 0;
};

struct VideoTimestampUpdate {
  double seconds;
  bool resetPacing;
};

inline VideoTimestampUpdate UpdatePresentationTimestamp(
    uint32_t timestampMs,
    VideoTimestampState& state,
    uint32_t discontinuityThresholdMs) {
  if (!state.initialized) {
    state.initialized = true;
    state.lastRawTimestampMs = timestampMs;
    state.elapsedTimestampMs = 0;
    return {0.0, true};
  }

  const int32_t deltaMs = static_cast<int32_t>(timestampMs - state.lastRawTimestampMs);
  if (deltaMs < 0) {
    const auto backwardsDeltaMs =
      static_cast<uint32_t>(-static_cast<int64_t>(deltaMs));
    if (backwardsDeltaMs > discontinuityThresholdMs) {
      state.lastRawTimestampMs = timestampMs;
      return {
        static_cast<double>(state.elapsedTimestampMs) / 1000.0,
        true,
      };
    }

    return {
      static_cast<double>(state.elapsedTimestampMs) / 1000.0,
      false,
    };
  }

  const auto forwardDeltaMs = static_cast<uint32_t>(deltaMs);
  state.lastRawTimestampMs = timestampMs;
  state.elapsedTimestampMs += forwardDeltaMs;
  return {
    static_cast<double>(state.elapsedTimestampMs) / 1000.0,
    forwardDeltaMs > discontinuityThresholdMs,
  };
}

class AdaptiveSpinWindow {
 public:
  AdaptiveSpinWindow(
      std::chrono::microseconds initial,
      std::chrono::microseconds minimum,
      std::chrono::microseconds maximum,
      double alpha)
      : m_Minimum(minimum),
        m_Maximum(maximum),
        m_Alpha(alpha),
        m_AverageMicroseconds(initial.count()) {}

  void ObserveOvershoot(std::chrono::microseconds overshoot) {
    const double observed = std::max<int64_t>(0, overshoot.count());
    m_AverageMicroseconds = (m_Alpha * observed)
      + ((1.0 - m_Alpha) * m_AverageMicroseconds);
  }

  std::chrono::microseconds value() const {
    const auto rounded = static_cast<int64_t>(std::llround(m_AverageMicroseconds));
    return std::chrono::microseconds(std::clamp(rounded, m_Minimum.count(), m_Maximum.count()));
  }

 private:
  std::chrono::microseconds m_Minimum;
  std::chrono::microseconds m_Maximum;
  double m_Alpha;
  double m_AverageMicroseconds;
};

enum class PacingCommitOutcome {
  Cancelled,
  AppendFailed,
  Committed,
};

template <typename Cancellation, typename Append, typename Commit>
PacingCommitOutcome AppendAndCommitPacingState(
    const Cancellation& cancellation,
    Append append,
    Commit commit) {
  if (cancellation.load()) {
    return PacingCommitOutcome::Cancelled;
  }
  if (!append()) {
    return PacingCommitOutcome::AppendFailed;
  }
  if (cancellation.load()) {
    return PacingCommitOutcome::Cancelled;
  }

  commit();
  return PacingCommitOutcome::Committed;
}

// Frame pacing holds a frame until its presentation time, so that frames that came in a burst are shown evenly. Presentation time is
// "anchor + timestamp of the frame", and the anchor used to be set by the first frame (or the first one after a gap of 250 ms) and never
// moved: when that frame was late (a stall of the network, a big first frame) every later frame that arrived sooner was held in the queue
// to the same delay, for good. A stall of 136 ms became 136 ms of delay for the whole stream.
//
// The anchor is now the delay that the frames of the last two seconds nearly all met: the lowest offset (arrival minus timestamp) plus the
// jitter below which 19 frames of 20 arrived. A frame that is later than that is shown at once, and no frame is held for more than a few
// frame intervals, so the delay follows the network instead of the worst moment of it.
//
// Not every frame says something about the jitter, and counting them all alike made the hold 30 to 60 ms for seconds (TV log of
// 2026-10-22). Two kinds of frames have no vote:
//
// - A frame that comes slower than the pace of the stream and more than a frame interval late. While the picture is still, the host
//   repeats the last frame a few times a second with a timestamp that it makes up (about the time of the frame before), so these frames
//   look 30 to 55 ms late. Holding the real frames for them made every move after a still picture start late. The frame before a slow
//   one is counted as slow too: the first repeated frame follows a real one closely by its timestamp.
// - A frame that arrived right behind the one before it (in less than half the time between their timestamps). It waited for that
//   frame: its delay is the same event, not a second measurement. So one stall of the network counts once, and only delays that keep
//   coming raise the hold.
//
// The arrival that the caller reports must be the time the frame was received, not the time the pacing thread took it from the queue:
// the wait behind a frame that the pacing holds is the pacing's own doing, and counted as jitter it kept the hold up for 10 to 15 seconds.

// The longest that a frame may be held: three frame intervals, but not less than 20 and not more than 50 ms
inline int64_t PlayoutMaxBufferUs(int64_t frameIntervalUs) {
  return std::clamp<int64_t>(3 * frameIntervalUs, 20000, 50000);
}

class PlayoutAnchor {
 public:
  static constexpr size_t kWindowFrames = 120;       // two seconds at 60 FPS
  static constexpr int64_t kMaxRiseUsPerFrame = 1000;  // a hold that grows does so gently; it falls at once

  // frameIntervalUs: the pace of the stream. Without it no frame counts as slow.
  explicit PlayoutAnchor(int64_t maxBufferUs, int64_t frameIntervalUs = 0)
      : m_MaxBufferUs(maxBufferUs), m_FrameIntervalUs(frameIntervalUs) {}

  // The first frame of a timeline. offsetUs: when the frame arrived minus its presentation timestamp. Returns the anchor, the offset at
  // which presentation time zero plays.
  int64_t Observe(int64_t offsetUs) { return Add(offsetUs, 0); }

  // A frame that follows another one. ptsGapUs: its timestamp minus the timestamp of the frame before; arrivalGapUs: the same for the
  // times that the two arrived.
  int64_t Observe(int64_t offsetUs, int64_t ptsGapUs, int64_t arrivalGapUs) {
    uint8_t kind = 0;
    if (m_FrameIntervalUs > 0 && ptsGapUs >= m_FrameIntervalUs + m_FrameIntervalUs / 2) {
      kind |= kSlow;
      if (m_Count > 0) {
        m_Kinds[(m_Next + kWindowFrames - 1) % kWindowFrames] |= kSlow;
      }
    }
    if (ptsGapUs > 0 && arrivalGapUs * 2 < ptsGapUs) {
      kind |= kFollower;
    }
    return Add(offsetUs, kind);
  }

  // How far behind the best case the frames are held: the anchor above the lowest offset of the window
  int64_t BufferUs() const { return m_HasAnchor ? std::max<int64_t>(0, m_Anchor - m_Lowest) : 0; }

  // A new timeline (the first frame, the timestamps jumped backwards)
  void Reset() {
    m_Count = 0;
    m_Next = 0;
    m_HasAnchor = false;
    m_Anchor = 0;
    m_Lowest = 0;
  }

 private:
  static constexpr uint8_t kSlow = 1;      // slower than the pace of the stream, or the frame before such a frame
  static constexpr uint8_t kFollower = 2;  // arrived right behind the frame before it

  int64_t Add(int64_t offsetUs, uint8_t kind) {
    m_Offsets[m_Next] = offsetUs;
    m_Kinds[m_Next] = kind;
    m_Next = (m_Next + 1) % kWindowFrames;
    if (m_Count < kWindowFrames) {
      ++m_Count;
    }

    m_Lowest = *std::min_element(m_Offsets, m_Offsets + m_Count);

    int64_t voters[kWindowFrames];
    size_t voterCount = 0;
    for (size_t i = 0; i < m_Count; ++i) {
      if (m_Kinds[i] & kFollower) {
        continue;
      }
      if ((m_Kinds[i] & kSlow) && m_Offsets[i] > m_Lowest + m_FrameIntervalUs) {
        continue;
      }
      voters[voterCount++] = m_Offsets[i];
    }

    // Nothing speaks of jitter: the frames are shown as they come
    int64_t wanted = m_Lowest;
    if (voterCount > 0) {
      // 19 of 20, and with only a few frames the late ones are left out as well: the middle of three, the lower of two
      const size_t index = static_cast<size_t>(0.95 * static_cast<double>(voterCount - 1));
      std::nth_element(voters, voters + index, voters + voterCount);
      wanted = std::min(voters[index], m_Lowest + m_MaxBufferUs);
    }

    if (!m_HasAnchor || wanted <= m_Anchor) {
      m_Anchor = wanted;
    } else {
      m_Anchor = std::min(wanted, m_Anchor + kMaxRiseUsPerFrame);
    }
    m_HasAnchor = true;
    return m_Anchor;
  }

  int64_t m_MaxBufferUs;
  int64_t m_FrameIntervalUs;
  int64_t m_Offsets[kWindowFrames] = {};
  uint8_t m_Kinds[kWindowFrames] = {};
  size_t m_Count = 0;
  size_t m_Next = 0;
  bool m_HasAnchor = false;
  int64_t m_Anchor = 0;
  int64_t m_Lowest = 0;
};

struct PacingWait {
  std::chrono::microseconds sleep{0};
  std::chrono::microseconds spin{0};
};

inline PacingWait CalculatePacingWait(
    std::chrono::microseconds remaining,
    std::chrono::microseconds spinWindow) {
  if (remaining <= std::chrono::microseconds::zero()) {
    return {};
  }

  if (remaining <= spinWindow) {
    return {std::chrono::microseconds::zero(), remaining};
  }

  return {remaining - spinWindow, spinWindow};
}

#endif
