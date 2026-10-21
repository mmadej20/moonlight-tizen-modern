#include "diagnostic_log.hpp"

#include <utility>

namespace {

constexpr std::size_t kDiagnosticBufferCapacity = 256 * 1024;
DiagnosticLogBuffer g_DiagnosticLogBuffer(kDiagnosticBufferCapacity);

std::string FormatRecord(uint64_t timestampMs, std::string_view message) {
  std::string record = "[" + std::to_string(timestampMs) + " ms] ";
  record.append(message.data(), message.size());
  if (record.empty() || record.back() != '\n') {
    record.push_back('\n');
  }
  return record;
}

std::string FormatDroppedRecord(uint64_t droppedRecords) {
  return "[diagnostics] dropped " + std::to_string(droppedRecords)
      + " diagnostic record" + (droppedRecords == 1 ? "" : "s") + "\n";
}

}  // namespace

DiagnosticLogBuffer::DiagnosticLogBuffer(std::size_t capacityBytes)
    : m_CapacityBytes(capacityBytes) {}

bool DiagnosticLogBuffer::TryAppend(uint64_t timestampMs, std::string_view message) {
  if (!Enabled()) {
    return false;
  }

  std::string record = FormatRecord(timestampMs, message);
  if (record.size() > m_CapacityBytes) {
    m_DroppedRecords.fetch_add(1, std::memory_order_relaxed);
    return false;
  }

  std::unique_lock<std::mutex> lock(m_Mutex, std::try_to_lock);
  if (!lock.owns_lock()) {
    m_DroppedRecords.fetch_add(1, std::memory_order_relaxed);
    return false;
  }

  const uint64_t droppedRecords = m_DroppedRecords.exchange(0, std::memory_order_relaxed);
  if (droppedRecords != 0) {
    std::string droppedRecord = FormatDroppedRecord(droppedRecords);
    if (droppedRecord.size() <= m_CapacityBytes) {
      PushRecord(std::move(droppedRecord));
    }
  }

  PushRecord(std::move(record));
  return true;
}

std::string DiagnosticLogBuffer::Drain() {
  std::deque<std::string> records;
  {
    std::lock_guard<std::mutex> lock(m_Mutex);
    records.swap(m_Records);
    m_SizeBytes = 0;
  }

  std::size_t totalSize = 0;
  for (const auto& record : records) {
    totalSize += record.size();
  }

  std::string result;
  result.reserve(totalSize);
  for (const auto& record : records) {
    result += record;
  }
  return result;
}

void DiagnosticLogBuffer::EvictUntilFits(std::size_t incomingBytes) {
  while (!m_Records.empty() && m_SizeBytes + incomingBytes > m_CapacityBytes) {
    m_SizeBytes -= m_Records.front().size();
    m_Records.pop_front();
  }
}

void DiagnosticLogBuffer::PushRecord(std::string record) {
  EvictUntilFits(record.size());
  m_SizeBytes += record.size();
  m_Records.push_back(std::move(record));
}

bool DiagnosticLogTryAppend(uint64_t timestampMs, std::string_view message) {
  return g_DiagnosticLogBuffer.TryAppend(timestampMs, message);
}

std::string DrainDiagnosticLogs() {
  return g_DiagnosticLogBuffer.Drain();
}

void SetDiagnosticLogEnabled(bool enabled) {
  g_DiagnosticLogBuffer.SetEnabled(enabled);
}
