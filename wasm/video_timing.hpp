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

// The longest that a frame may be held: three frame intervals, but not less than 20 and not more than 50 ms
inline int64_t PlayoutMaxBufferUs(int64_t frameIntervalUs) {
  return std::clamp<int64_t>(3 * frameIntervalUs, 20000, 50000);
}

class PlayoutAnchor {
 public:
  static constexpr size_t kWindowFrames = 120;       // two seconds at 60 FPS
  static constexpr int64_t kMaxRiseUsPerFrame = 1000;  // a hold that grows does so gently; it falls at once

  explicit PlayoutAnchor(int64_t maxBufferUs) : m_MaxBufferUs(maxBufferUs) {}

  // offsetUs: when the frame arrived minus its presentation timestamp. Returns the anchor, the offset at which presentation time zero plays.
  int64_t Observe(int64_t offsetUs) {
    m_Offsets[m_Next] = offsetUs;
    m_Next = (m_Next + 1) % kWindowFrames;
    if (m_Count < kWindowFrames) {
      ++m_Count;
    }

    int64_t sorted[kWindowFrames];
    std::copy(m_Offsets, m_Offsets + m_Count, sorted);
    m_Lowest = *std::min_element(sorted, sorted + m_Count);
    // 19 of 20, and with only a few frames the late ones are left out as well: the middle of three, the lower of two
    const size_t index = static_cast<size_t>(0.95 * static_cast<double>(m_Count - 1));
    std::nth_element(sorted, sorted + index, sorted + m_Count);
    const int64_t wanted = std::min(sorted[index], m_Lowest + m_MaxBufferUs);

    if (!m_HasAnchor || wanted <= m_Anchor) {
      m_Anchor = wanted;
    } else {
      m_Anchor = std::min(wanted, m_Anchor + kMaxRiseUsPerFrame);
    }
    m_HasAnchor = true;
    return m_Anchor;
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
  int64_t m_MaxBufferUs;
  int64_t m_Offsets[kWindowFrames] = {};
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
