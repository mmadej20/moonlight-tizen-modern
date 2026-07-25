#include "wasm/dispatcher/lib.hpp"

#include <atomic>
#include <cassert>
#include <condition_variable>
#include <mutex>
#include <thread>

int main() {
  Dispatcher dispatcher("test");
  assert(dispatcher.start());
  assert(!dispatcher.start());

  std::mutex mutex;
  std::condition_variable cv;
  bool workerStarted = false;
  bool releaseWorker = false;
  bool selfStopReturned = false;
  int externalStopsStarted = 0;
  int externalStopsReturned = 0;
  std::atomic<int> acceptedCalls{0};
  int acceptedJobs = 0;
  std::atomic<int> rejectedCalls{0};

  assert(dispatcher.post_job(
      [&] {
        {
          std::unique_lock<std::mutex> lock(mutex);
          workerStarted = true;
          cv.notify_all();
          cv.wait(lock, [&] { return releaseWorker; });
        }

        dispatcher.stop();

        {
          std::lock_guard<std::mutex> lock(mutex);
          selfStopReturned = true;
        }
        cv.notify_all();
      },
      false));

  {
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock, [&] { return workerStarted; });
  }

  std::thread externalStoppers[2];
  for (auto& externalStopper : externalStoppers) {
    externalStopper = std::thread([&] {
      {
        std::lock_guard<std::mutex> lock(mutex);
        ++externalStopsStarted;
      }
      cv.notify_all();
      dispatcher.stop();
      {
        std::lock_guard<std::mutex> lock(mutex);
        ++externalStopsReturned;
      }
      cv.notify_all();
    });
  }

  {
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock, [&] { return externalStopsStarted == 2; });
  }

  while (dispatcher.post_job([&] { ++acceptedCalls; }, false)) {
    ++acceptedJobs;
    std::this_thread::yield();
  }
  assert(!dispatcher.post_job([&] { ++rejectedCalls; }, false));

  {
    std::lock_guard<std::mutex> lock(mutex);
    releaseWorker = true;
  }
  cv.notify_all();

  for (auto& externalStopper : externalStoppers) {
    externalStopper.join();
  }
  {
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock, [&] {
      return selfStopReturned && externalStopsReturned == 2;
    });
  }
  assert(acceptedCalls.load() == acceptedJobs);
  assert(rejectedCalls.load() == 0);

  assert(dispatcher.start());
  std::atomic<int> restartCalls{0};
  assert(dispatcher.post_job([&] { ++restartCalls; }, false));
  dispatcher.stop();
  dispatcher.stop();

  assert(restartCalls.load() == 1);
  assert(rejectedCalls.load() == 0);
  return 0;
}
