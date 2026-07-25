#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>

enum class OperationOutcome {
  Pending,
  Success,
  Failure,
  Cancelled,
  Timeout,
};

class OperationLatch {
 public:
  void Reset() {
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_Outcome = OperationOutcome::Pending;
  }

  void Succeed() { Complete(OperationOutcome::Success); }
  void Fail() { Complete(OperationOutcome::Failure); }
  void Cancel() { Complete(OperationOutcome::Cancelled); }

  void Notify() {
    {
      std::lock_guard<std::mutex> lock(m_Mutex);
    }
    m_Condition.notify_all();
  }

  template <typename Rep, typename Period, typename CancellationFlag>
  OperationOutcome WaitFor(
      std::chrono::duration<Rep, Period> timeout,
      const CancellationFlag& cancelled) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    std::unique_lock<std::mutex> lock(m_Mutex);

    const auto terminal = [this, &cancelled] {
      if (m_Outcome != OperationOutcome::Pending) {
        return true;
      }
      if (cancelled.load()) {
        m_Outcome = OperationOutcome::Cancelled;
        return true;
      }
      return false;
    };

    if (!m_Condition.wait_until(lock, deadline, terminal) &&
        m_Outcome == OperationOutcome::Pending) {
      m_Outcome = OperationOutcome::Timeout;
    }
    return m_Outcome;
  }

  OperationOutcome outcome() const {
    std::lock_guard<std::mutex> lock(m_Mutex);
    return m_Outcome;
  }

 private:
  void Complete(OperationOutcome outcome) {
    {
      std::lock_guard<std::mutex> lock(m_Mutex);
      if (m_Outcome != OperationOutcome::Pending) {
        return;
      }
      m_Outcome = outcome;
    }
    m_Condition.notify_all();
  }

  mutable std::mutex m_Mutex;
  std::condition_variable m_Condition;
  OperationOutcome m_Outcome{OperationOutcome::Pending};
};
