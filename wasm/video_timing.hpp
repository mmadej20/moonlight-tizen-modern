#ifndef MOONLIGHT_VIDEO_TIMING_HPP
#define MOONLIGHT_VIDEO_TIMING_HPP

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>

struct VideoTimestampState {
  bool initialized = false;
  uint32_t lastRawTimestampMs = 0;
  uint64_t elapsedTimestampMs = 0;
};

struct VideoTimestampUpdate {
  double seconds;
  bool discontinuity;
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
  state.lastRawTimestampMs = timestampMs;
  if (deltaMs < 0 || static_cast<uint32_t>(deltaMs) > discontinuityThresholdMs) {
    return {
      static_cast<double>(state.elapsedTimestampMs) / 1000.0,
      true,
    };
  }

  state.elapsedTimestampMs += static_cast<uint32_t>(deltaMs);
  return {
    static_cast<double>(state.elapsedTimestampMs) / 1000.0,
    false,
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
