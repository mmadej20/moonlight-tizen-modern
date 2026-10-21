#ifndef MOONLIGHT_TIZEN_LOG_REPEAT_FILTER_HPP
#define MOONLIGHT_TIZEN_LOG_REPEAT_FILTER_HPP

#include <cstdint>
#include <mutex>
#include <string>
#include <string_view>

// The streaming library reports the same condition on every packet or poll ("Input queue reached maximum size limit"
// came 80000 times in a few minutes once the thread that empties the queue had died). Each line is formatted, sent to
// the console and kept in the diagnostic log, so the flood filled the 2 MB log file of the application, and the
// application then rewrote that whole file on the main thread every second. An identical message that follows itself
// within a second is left out and counted, and the count is reported with the next message that is logged.
class LogRepeatFilter {
 public:
  struct Decision {
    bool log;               // false: leave this message out
    unsigned int repeated;  // identical messages that were left out before this one
  };

  static constexpr std::uint64_t kWindowMs = 1000;

  Decision Check(std::string_view message, std::uint64_t nowMs) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    if (m_HasLast && nowMs - m_LastLoggedMs < kWindowMs && message == m_Last) {
      ++m_Suppressed;
      return {false, 0};
    }
    const Decision decision{true, m_Suppressed};
    m_Suppressed = 0;
    m_Last.assign(message.data(), message.size());
    m_LastLoggedMs = nowMs;
    m_HasLast = true;
    return decision;
  }

 private:
  std::mutex m_Mutex;
  std::string m_Last;
  std::uint64_t m_LastLoggedMs = 0;
  unsigned int m_Suppressed = 0;
  bool m_HasLast = false;
};

#endif
