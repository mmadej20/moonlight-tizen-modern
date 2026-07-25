#include "wasm/connection_lifecycle.hpp"

#include <atomic>
#include <cassert>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

int main() {
  ConnectionLifecycle lifecycle;
  assert(lifecycle.state() == ConnectionState::Idle);
  assert(lifecycle.TryStart());
  assert(!lifecycle.TryStart());
  assert(lifecycle.MarkRunning());

  int winners = 0;
  std::vector<std::thread> callers;
  for (int i = 0; i < 16; ++i) {
    callers.emplace_back([&] {
      if (lifecycle.BeginStop()) {
        __atomic_add_fetch(&winners, 1, __ATOMIC_RELAXED);
      }
    });
  }
  for (auto& caller : callers) caller.join();
  assert(winners == 1);
  assert(lifecycle.state() == ConnectionState::Stopping);
  lifecycle.MarkIdle();
  assert(lifecycle.state() == ConnectionState::Idle);

  ConnectionLifecycle starting;
  assert(starting.TryStart());
  assert(starting.BeginStop());
  starting.MarkIdle();

  ConnectionLifecycle stoppedBeforeGuard;
  assert(stoppedBeforeGuard.TryStart());
  assert(stoppedBeforeGuard.BeginStop());
  auto deniedGuard = stoppedBeforeGuard.AcquireStartGuard();
  assert(!deniedGuard);

  ConnectionLifecycle guardedStartup;
  assert(guardedStartup.TryStart());

  std::mutex startupMutex;
  std::condition_variable startupCv;
  bool guardHeld = false;
  bool stopReady = false;
  std::atomic<int> sequence{0};
  std::atomic<int> mutationOrder{0};
  std::atomic<int> stopOrder{0};

  std::thread starter([&] {
    auto startGuard = guardedStartup.AcquireStartGuard();
    assert(startGuard);
    {
      std::lock_guard<std::mutex> lock(startupMutex);
      guardHeld = true;
    }
    startupCv.notify_all();

    {
      std::unique_lock<std::mutex> lock(startupMutex);
      startupCv.wait(lock, [&] { return stopReady; });
    }

    mutationOrder.store(++sequence);
  });

  std::thread stopper([&] {
    {
      std::unique_lock<std::mutex> lock(startupMutex);
      startupCv.wait(lock, [&] { return guardHeld; });
      stopReady = true;
    }
    startupCv.notify_all();

    assert(guardedStartup.BeginStop());
    stopOrder.store(++sequence);
  });

  starter.join();
  stopper.join();
  assert(mutationOrder.load() == 1);
  assert(stopOrder.load() == 2);
  assert(guardedStartup.state() == ConnectionState::Stopping);

  ConnectionLifecycle competingStops;
  assert(competingStops.TryStart());
  assert(competingStops.MarkRunning());

  std::mutex competitionMutex;
  std::condition_variable competitionCv;
  bool compete = false;
  std::atomic<int> stopWinners{0};
  std::vector<std::thread> competingThreads;
  for (int i = 0; i < 2; ++i) {
    competingThreads.emplace_back([&] {
      {
        std::unique_lock<std::mutex> lock(competitionMutex);
        competitionCv.wait(lock, [&] { return compete; });
      }
      if (competingStops.BeginStop()) {
        ++stopWinners;
      }
    });
  }

  {
    std::lock_guard<std::mutex> lock(competitionMutex);
    compete = true;
  }
  competitionCv.notify_all();
  for (auto& thread : competingThreads) {
    thread.join();
  }
  assert(stopWinners.load() == 1);
  return 0;
}
