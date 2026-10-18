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

// Everything that threads share here is 32 bits wide. The Samsung Emscripten lowers 64-bit atomics to library
// calls and gets the signature of the compare-exchange one wrong (asm2wasm: "adding operands in call to
// ___atomic_compare_exchange_8"): a loop on a 64-bit compare_exchange spun forever on the TV, froze the
// connection thread at its first status message and left the application on "Starting <game>...".
// Times are therefore kept as the low 32 bits of the millisecond clock and subtracted with wrapping, which is
// exact for any span shorter than 24 days.
namespace stream_health_detail {

inline uint32_t Low(int64_t ms) { return static_cast<uint32_t>(ms); }

// Milliseconds from a stored time to now; never negative, because threads read the clock a moment apart
inline int64_t Since(int64_t nowMs, uint32_t earlierLowMs) {
  const int32_t elapsed = static_cast<int32_t>(Low(nowMs) - earlierLowMs);
  return elapsed < 0 ? 0 : elapsed;
}

inline uint32_t ClampDuration(int64_t durationMs) {
  if (durationMs < 0) return 0;
  return durationMs > 0xFFFFFFFFLL ? 0xFFFFFFFFu : static_cast<uint32_t>(durationMs);
}

}  // namespace stream_health_detail

// A stretch of code that can block for long: a call into the platform media pipeline, or a
// synchronous call that waits for the main thread. It counts the calls, keeps the longest one of
// the current window, and knows how long a thread has been inside right now.
class BlockingSection {
 public:
  void Reset() {
    m_Count.store(0);
    m_MaxMs.store(0);
    m_InFlight.store(0);
    m_SinceMs.store(0);
  }

  void Begin(int64_t nowMs) {
    if (m_InFlight.fetch_add(1) == 0) {
      m_SinceMs.store(stream_health_detail::Low(nowMs));
    }
  }

  void End(int64_t startMs, int64_t nowMs) {
    m_Count.fetch_add(1);

    const uint32_t durationMs = stream_health_detail::ClampDuration(nowMs - startMs);
    uint32_t currentMax = m_MaxMs.load();
    while (durationMs > currentMax && !m_MaxMs.compare_exchange_weak(currentMax, durationMs)) {
    }

    // A Reset() while a thread was inside leaves the counter below zero after its End()
    if (m_InFlight.fetch_sub(1) < 1) {
      m_InFlight.store(0);
    }
  }

  uint32_t Count() const { return m_Count.load(); }

  // The longest call since the previous call to this function
  int64_t TakeMaxMs() { return m_MaxMs.exchange(0); }

  // 0 when no thread is inside; otherwise how long the first of them has been waiting
  int64_t BlockedMs(int64_t nowMs) const {
    return m_InFlight.load() > 0 ? stream_health_detail::Since(nowMs, m_SinceMs.load()) : 0;
  }

 private:
  std::atomic<uint32_t> m_Count{0};
  std::atomic<uint32_t> m_MaxMs{0};
  std::atomic<int32_t> m_InFlight{0};
  std::atomic<uint32_t> m_SinceMs{0};
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
    m_ResetMs.store(stream_health_detail::Low(nowMs));
    m_VideoCount.store(0);
    m_AudioCount.store(0);
    m_HasVideo.store(false);
    m_HasAudio.store(false);
    m_VideoAppend.Reset();
    m_AudioAppend.Reset();
    m_InputPoll.Reset();
    m_MainCall.Reset();
  }

  void VideoSubmitted(int64_t nowMs) {
    m_VideoCount.fetch_add(1);
    m_LastVideoMs.store(stream_health_detail::Low(nowMs));
    m_HasVideo.store(true);
  }

  void AudioSubmitted(int64_t nowMs) {
    m_AudioCount.fetch_add(1);
    m_LastAudioMs.store(stream_health_detail::Low(nowMs));
    m_HasAudio.store(true);
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
    const int64_t videoAge =
      m_HasVideo.load() ? stream_health_detail::Since(nowMs, m_LastVideoMs.load()) : -1;
    const int64_t audioAge =
      m_HasAudio.load() ? stream_health_detail::Since(nowMs, m_LastAudioMs.load()) : -1;

    char buffer[512];
    std::snprintf(
      buffer, sizeof(buffer),
      "video=%llu/%lldms audio=%llu/%lldms"
      " videoAppendCalls=%llu videoAppendMaxMs=%lld videoAppendBlockedMs=%lld"
      " audioAppendCalls=%llu audioAppendMaxMs=%lld audioAppendBlockedMs=%lld"
      " inputPolls=%llu inputPollMaxMs=%lld inputPollBlockedMs=%lld"
      " mainCalls=%llu mainCallMaxMs=%lld mainCallBlockedMs=%lld heap=%lluMB/%lluMB",
      static_cast<unsigned long long>(m_VideoCount.load()),
      static_cast<long long>(videoAge),
      static_cast<unsigned long long>(m_AudioCount.load()),
      static_cast<long long>(audioAge),
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
  std::atomic<uint32_t> m_ResetMs{0};
  std::atomic<uint32_t> m_VideoCount{0};
  std::atomic<uint32_t> m_AudioCount{0};
  std::atomic<uint32_t> m_LastVideoMs{0};
  std::atomic<uint32_t> m_LastAudioMs{0};
  std::atomic<bool> m_HasVideo{false};
  std::atomic<bool> m_HasAudio{false};
  BlockingSection m_VideoAppend;
  BlockingSection m_AudioAppend;
  BlockingSection m_InputPoll;
  BlockingSection m_MainCall;
};
