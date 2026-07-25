#include "wasm/operation_latch.hpp"

#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <future>
#include <mutex>
#include <thread>

using namespace std::chrono_literals;

class HandoffCancellation {
 public:
  bool load() const {
    std::unique_lock<std::mutex> lock(m_Mutex);
    const bool snapshot = m_Cancelled;
    if (!m_HandoffObserved) {
      m_HandoffObserved = true;
      m_Condition.notify_all();
      m_Condition.wait(lock, [this] { return m_ReleaseHandoff; });
    }
    return snapshot;
  }

  void WaitForHandoff() {
    std::unique_lock<std::mutex> lock(m_Mutex);
    m_Condition.wait(lock, [this] { return m_HandoffObserved; });
  }

  void Cancel() {
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_Cancelled = true;
  }

  void ReleaseHandoff() {
    {
      std::lock_guard<std::mutex> lock(m_Mutex);
      m_ReleaseHandoff = true;
    }
    m_Condition.notify_all();
  }

 private:
  mutable std::mutex m_Mutex;
  mutable std::condition_variable m_Condition;
  mutable bool m_HandoffObserved{false};
  bool m_ReleaseHandoff{false};
  bool m_Cancelled{false};
};

int main() {
  std::atomic<bool> cancelled{false};

  OperationLatch success;
  std::thread worker([&] { success.Succeed(); });
  assert(success.WaitFor(100ms, cancelled) == OperationOutcome::Success);
  worker.join();

  OperationLatch failure;
  failure.Fail();
  assert(failure.WaitFor(100ms, cancelled) == OperationOutcome::Failure);

  OperationLatch timeout;
  assert(timeout.WaitFor(2ms, cancelled) == OperationOutcome::Timeout);
  cancelled.store(true);
  timeout.Notify();
  assert(timeout.WaitFor(100ms, cancelled) == OperationOutcome::Timeout);
  timeout.Succeed();
  assert(timeout.outcome() == OperationOutcome::Timeout);

  OperationLatch cancellation;
  cancelled.store(true);
  cancellation.Notify();
  assert(cancellation.WaitFor(100ms, cancelled) == OperationOutcome::Cancelled);
  assert(cancellation.outcome() == OperationOutcome::Cancelled);
  cancellation.Succeed();
  assert(cancellation.outcome() == OperationOutcome::Cancelled);

  OperationLatch successBeforeCancellation;
  cancelled.store(false);
  successBeforeCancellation.Succeed();
  cancelled.store(true);
  successBeforeCancellation.Notify();
  assert(successBeforeCancellation.WaitFor(100ms, cancelled) == OperationOutcome::Success);
  assert(successBeforeCancellation.outcome() == OperationOutcome::Success);

  OperationLatch directCancellation;
  cancelled.store(false);
  directCancellation.Cancel();
  assert(directCancellation.WaitFor(100ms, cancelled) == OperationOutcome::Cancelled);

  cancellation.Reset();
  cancelled.store(false);
  cancellation.Succeed();
  cancellation.Fail();
  assert(cancellation.outcome() == OperationOutcome::Success);

  OperationLatch handoff;
  HandoffCancellation handoffCancellation;
  std::promise<OperationOutcome> handoffResultPromise;
  auto handoffResult = handoffResultPromise.get_future();
  std::thread handoffWaiter([&] {
    handoffResultPromise.set_value(handoff.WaitFor(10s, handoffCancellation));
  });

  handoffCancellation.WaitForHandoff();
  handoffCancellation.Cancel();

  std::promise<void> notifyStartedPromise;
  auto notifyStarted = notifyStartedPromise.get_future();
  std::promise<void> notifyReturnedPromise;
  auto notifyReturned = notifyReturnedPromise.get_future();
  std::thread handoffNotifier([&] {
    notifyStartedPromise.set_value();
    handoff.Notify();
    notifyReturnedPromise.set_value();
  });
  notifyStarted.wait();

  // With the broken unlocked Notify(), this completes before the waiter can
  // enter wait_until(), deterministically placing the notification in the
  // lost-wakeup window. A locking Notify() waits for the predicate handoff.
  notifyReturned.wait_for(250ms);
  handoffCancellation.ReleaseHandoff();

  const auto handoffStatus = handoffResult.wait_for(1s);
  if (handoffStatus != std::future_status::ready) {
    handoff.Cancel();
    handoff.Notify();
  }
  handoffNotifier.join();
  handoffWaiter.join();
  assert(handoffStatus == std::future_status::ready);
  assert(handoffResult.get() == OperationOutcome::Cancelled);
  return 0;
}
