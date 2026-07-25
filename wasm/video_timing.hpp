#ifndef MOONLIGHT_VIDEO_TIMING_HPP
#define MOONLIGHT_VIDEO_TIMING_HPP

#include <chrono>
#include <cstdint>

struct VideoTimestampState {
  bool initialized = false;
  uint32_t lastRawTimestampMs = 0;
  uint64_t elapsedTimestampMs = 0;
};

inline double RebasePresentationTimestamp(uint32_t timestampMs, VideoTimestampState& state) {
  if (!state.initialized) {
    state.initialized = true;
    state.lastRawTimestampMs = timestampMs;
    state.elapsedTimestampMs = 0;
    return 0.0;
  }

  const int32_t deltaMs = static_cast<int32_t>(timestampMs - state.lastRawTimestampMs);
  if (deltaMs >= 0) {
    state.elapsedTimestampMs += static_cast<uint32_t>(deltaMs);
    state.lastRawTimestampMs = timestampMs;
  }

  return static_cast<double>(state.elapsedTimestampMs) / 1000.0;
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
