#include "wasm/media_operation_epoch.hpp"
#include "wasm/operation_latch.hpp"

#include <atomic>
#include <cassert>
#include <chrono>

using namespace std::chrono_literals;

int main() {
  MediaOperationEpoch epoch;
  int firstSource = 0;
  int secondSource = 0;
  int mediaState = 0;

  const auto firstStream = epoch.Begin(&firstSource);
  assert(epoch.RunIfActive(firstStream, [&] { mediaState = 1; }));

  const auto secondStream = epoch.Begin(&secondSource);
  assert(!epoch.RunIfActive(firstStream, [&] { mediaState = 2; }));
  assert(mediaState == 1);
  assert(epoch.RunIfActive(secondStream, [&] { mediaState = 3; }));
  assert(mediaState == 3);

  std::atomic<bool> cancelled{false};
  OperationLatch timedOutClose;
  const auto firstClose = epoch.Begin(&firstSource);
  assert(timedOutClose.WaitFor(0ms, cancelled) == OperationOutcome::Timeout);

  OperationLatch nextOperation;
  const auto secondClose = epoch.Begin(&secondSource);
  assert(!epoch.RunIfActive(firstClose, [&] { nextOperation.Succeed(); }));
  assert(nextOperation.outcome() == OperationOutcome::Pending);
  assert(epoch.RunIfActive(secondClose, [&] { nextOperation.Succeed(); }));
  assert(nextOperation.outcome() == OperationOutcome::Success);

  epoch.Clear(secondClose);
  assert(!epoch.RunIfActive(secondClose, [&] { mediaState = 4; }));
  assert(mediaState == 3);
  return 0;
}
