#pragma once

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

// Cheap counters that tell which part of a stream stopped first when the application freezes.
// Worker threads only touch atomics. The JavaScript heartbeat reads a snapshot once per second
// and stores it, so after a freeze the last stored snapshot shows whether video, audio or the
// main thread stopped first, and whether the wasm heap was running out.
class StreamHealth {
 public:
  // Monotonic milliseconds, the same clock for every thread
  static int64_t NowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
  }

  void Reset(int64_t nowMs) {
    m_ResetMs.store(nowMs);
    m_VideoCount.store(0);
    m_AudioCount.store(0);
    m_LastVideoMs.store(-1);
    m_LastAudioMs.store(-1);
    m_MainCalls.store(0);
    m_MainCallMaxMs.store(0);
    m_MainCallsInFlight.store(0);
    m_BlockedSinceMs.store(-1);
  }

  void VideoSubmitted(int64_t nowMs) {
    m_VideoCount.fetch_add(1);
    m_LastVideoMs.store(nowMs);
  }

  void AudioSubmitted(int64_t nowMs) {
    m_AudioCount.fetch_add(1);
    m_LastAudioMs.store(nowMs);
  }

  // A worker thread is about to wait for the main thread (a synchronous call into JavaScript)
  void MainCallBegin(int64_t nowMs) {
    if (m_MainCallsInFlight.fetch_add(1) == 0) {
      m_BlockedSinceMs.store(nowMs);
    }
  }

  // The call that began at startMs returned
  void MainCallEnd(int64_t startMs, int64_t nowMs) {
    m_MainCalls.fetch_add(1);

    const int64_t durationMs = nowMs - startMs;
    int64_t currentMax = m_MainCallMaxMs.load();
    while (durationMs > currentMax &&
           !m_MainCallMaxMs.compare_exchange_weak(currentMax, durationMs)) {
    }

    if (m_MainCallsInFlight.fetch_sub(1) == 1) {
      m_BlockedSinceMs.store(-1);
    }
  }

  // One line describing the stream; the per-window maximum is reset by every call
  std::string Snapshot(int64_t nowMs, std::size_t heapUsedBytes, std::size_t heapTotalBytes) {
    const int64_t lastVideo = m_LastVideoMs.load();
    const int64_t lastAudio = m_LastAudioMs.load();
    const int64_t blockedSince = m_BlockedSinceMs.load();
    const bool blocked = m_MainCallsInFlight.load() > 0 && blockedSince >= 0;

    char buffer[256];
    std::snprintf(
      buffer, sizeof(buffer),
      "video=%llu/%lldms audio=%llu/%lldms mainCalls=%llu mainCallMaxMs=%lld mainCallBlockedMs=%lld heap=%lluMB/%lluMB",
      static_cast<unsigned long long>(m_VideoCount.load()),
      static_cast<long long>(lastVideo < 0 ? -1 : nowMs - lastVideo),
      static_cast<unsigned long long>(m_AudioCount.load()),
      static_cast<long long>(lastAudio < 0 ? -1 : nowMs - lastAudio),
      static_cast<unsigned long long>(m_MainCalls.load()),
      static_cast<long long>(m_MainCallMaxMs.exchange(0)),
      static_cast<long long>(blocked ? nowMs - blockedSince : 0),
      static_cast<unsigned long long>(heapUsedBytes >> 20),
      static_cast<unsigned long long>(heapTotalBytes >> 20));
    return buffer;
  }

 private:
  std::atomic<int64_t> m_ResetMs{0};
  std::atomic<uint64_t> m_VideoCount{0};
  std::atomic<uint64_t> m_AudioCount{0};
  std::atomic<int64_t> m_LastVideoMs{-1};
  std::atomic<int64_t> m_LastAudioMs{-1};
  std::atomic<uint64_t> m_MainCalls{0};
  std::atomic<int64_t> m_MainCallMaxMs{0};
  std::atomic<int> m_MainCallsInFlight{0};
  std::atomic<int64_t> m_BlockedSinceMs{-1};
};
