#ifndef MOONLIGHT_TIZEN_DIAGNOSTIC_LOG_HPP
#define MOONLIGHT_TIZEN_DIAGNOSTIC_LOG_HPP

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <string_view>

class DiagnosticLogBuffer {
 public:
  explicit DiagnosticLogBuffer(std::size_t capacityBytes);

  bool TryAppend(uint64_t timestampMs, std::string_view message);
  std::string Drain();

  // While the log is off nothing is formatted or kept, and nothing is counted as dropped
  void SetEnabled(bool enabled) { m_Enabled.store(enabled, std::memory_order_relaxed); }
  bool Enabled() const { return m_Enabled.load(std::memory_order_relaxed); }

 private:
  void EvictUntilFits(std::size_t incomingBytes);
  void PushRecord(std::string record);

  const std::size_t m_CapacityBytes;
  std::size_t m_SizeBytes = 0;
  std::deque<std::string> m_Records;
  std::mutex m_Mutex;
  std::atomic<uint64_t> m_DroppedRecords{0};
  std::atomic<bool> m_Enabled{true};
};

bool DiagnosticLogTryAppend(uint64_t timestampMs, std::string_view message);
std::string DrainDiagnosticLogs();
void SetDiagnosticLogEnabled(bool enabled);

#endif
