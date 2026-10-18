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

// A stretch of code that can block for long: a call into the platform media pipeline, or a
// synchronous call that waits for the main thread. It counts the calls, keeps the longest one of
// the current window, and knows how long a thread has been inside right now.
class BlockingSection {
 public:
  void Reset() {
    m_Count.store(0);
    m_MaxMs.store(0);
    m_InFlight.store(0);
    m_SinceMs.store(-1);
  }

  void Begin(int64_t nowMs) {
    if (m_InFlight.fetch_add(1) == 0) {
      m_SinceMs.store(nowMs);
    }
  }

  void End(int64_t startMs, int64_t nowMs) {
    m_Count.fetch_add(1);

    const int64_t durationMs = nowMs - startMs;
    int64_t currentMax = m_MaxMs.load();
    while (durationMs > currentMax && !m_MaxMs.compare_exchange_weak(currentMax, durationMs)) {
    }

    if (m_InFlight.fetch_sub(1) == 1) {
      m_SinceMs.store(-1);
    }
  }

  uint64_t Count() const { return m_Count.load(); }

  // The longest call since the previous call to this function
  int64_t TakeMaxMs() { return m_MaxMs.exchange(0); }

  // 0 when no thread is inside; otherwise how long the first of them has been waiting
  int64_t BlockedMs(int64_t nowMs) const {
    const int64_t since = m_SinceMs.load();
    return m_InFlight.load() > 0 && since >= 0 ? nowMs - since : 0;
  }

 private:
  std::atomic<uint64_t> m_Count{0};
  std::atomic<int64_t> m_MaxMs{0};
  std::atomic<int> m_InFlight{0};
  std::atomic<int64_t> m_SinceMs{-1};
};

// Enters a section for the lifetime of the object
class ScopedSection {
 public:
  explicit ScopedSection(BlockingSection& section);
  ScopedSection(BlockingSection& section, int64_t startMs)
      : m_Section(section), m_StartMs(startMs) {
    m_Section.Begin(m_StartMs);
  }

  ~ScopedSection() {
    if (!m_Finished) {
      Finish(NowMs());
    }
  }

  ScopedSection(const ScopedSection&) = delete;
  ScopedSection& operator=(const ScopedSection&) = delete;

  void Finish(int64_t nowMs) {
    if (m_Finished) {
      return;
    }
    m_Finished = true;
    m_Section.End(m_StartMs, nowMs);
  }

  // Monotonic milliseconds, the same clock for every thread
  static int64_t NowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
  }

 private:
  BlockingSection& m_Section;
  int64_t m_StartMs;
  bool m_Finished{false};
};

inline ScopedSection::ScopedSection(BlockingSection& section)
    : ScopedSection(section, NowMs()) {}

class StreamHealth {
 public:
  // Monotonic milliseconds, the same clock for every thread
  static int64_t NowMs() { return ScopedSection::NowMs(); }

  void Reset(int64_t nowMs) {
    m_ResetMs.store(nowMs);
    m_VideoCount.store(0);
    m_AudioCount.store(0);
    m_LastVideoMs.store(-1);
    m_LastAudioMs.store(-1);
    m_VideoAppend.Reset();
    m_AudioAppend.Reset();
    m_InputPoll.Reset();
    m_MainCall.Reset();
  }

  void VideoSubmitted(int64_t nowMs) {
    m_VideoCount.fetch_add(1);
    m_LastVideoMs.store(nowMs);
  }

  void AudioSubmitted(int64_t nowMs) {
    m_AudioCount.fetch_add(1);
    m_LastAudioMs.store(nowMs);
  }

  // The append of one video or audio packet into the platform media pipeline
  BlockingSection& VideoAppend() { return m_VideoAppend; }
  BlockingSection& AudioAppend() { return m_AudioAppend; }
  // One round of the input thread. It asks the main thread for the gamepad state, so a slow or
  // stuck main thread shows up here even when nothing else talks to it.
  BlockingSection& InputPoll() { return m_InputPoll; }
  // A worker thread waiting for the main thread (a synchronous call into JavaScript)
  BlockingSection& MainCall() { return m_MainCall; }

  // One line describing the stream; the per-window maxima are reset by every call
  std::string Snapshot(int64_t nowMs, std::size_t heapUsedBytes, std::size_t heapTotalBytes) {
    const int64_t lastVideo = m_LastVideoMs.load();
    const int64_t lastAudio = m_LastAudioMs.load();

    char buffer[512];
    std::snprintf(
      buffer, sizeof(buffer),
      "video=%llu/%lldms audio=%llu/%lldms"
      " videoAppendCalls=%llu videoAppendMaxMs=%lld videoAppendBlockedMs=%lld"
      " audioAppendCalls=%llu audioAppendMaxMs=%lld audioAppendBlockedMs=%lld"
      " inputPolls=%llu inputPollMaxMs=%lld inputPollBlockedMs=%lld"
      " mainCalls=%llu mainCallMaxMs=%lld mainCallBlockedMs=%lld heap=%lluMB/%lluMB",
      static_cast<unsigned long long>(m_VideoCount.load()),
      static_cast<long long>(lastVideo < 0 ? -1 : nowMs - lastVideo),
      static_cast<unsigned long long>(m_AudioCount.load()),
      static_cast<long long>(lastAudio < 0 ? -1 : nowMs - lastAudio),
      static_cast<unsigned long long>(m_VideoAppend.Count()),
      static_cast<long long>(m_VideoAppend.TakeMaxMs()),
      static_cast<long long>(m_VideoAppend.BlockedMs(nowMs)),
      static_cast<unsigned long long>(m_AudioAppend.Count()),
      static_cast<long long>(m_AudioAppend.TakeMaxMs()),
      static_cast<long long>(m_AudioAppend.BlockedMs(nowMs)),
      static_cast<unsigned long long>(m_InputPoll.Count()),
      static_cast<long long>(m_InputPoll.TakeMaxMs()),
      static_cast<long long>(m_InputPoll.BlockedMs(nowMs)),
      static_cast<unsigned long long>(m_MainCall.Count()),
      static_cast<long long>(m_MainCall.TakeMaxMs()),
      static_cast<long long>(m_MainCall.BlockedMs(nowMs)),
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
  BlockingSection m_VideoAppend;
  BlockingSection m_AudioAppend;
  BlockingSection m_InputPoll;
  BlockingSection m_MainCall;
};
