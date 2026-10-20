#include "wasm/alloc_stress.hpp"

#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

using namespace allocstress;

static bool WaitUntilFinished(Runner& runner, int limitSeconds) {
  const auto limit = std::chrono::steady_clock::now() + std::chrono::seconds(limitSeconds);
  while (!runner.Finished()) {
    if (std::chrono::steady_clock::now() > limit) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  return true;
}

int main() {
  // A healthy allocator and healthy locks: nothing may be reported
  {
    Runner runner;
    Config config;
    config.threads = 4;
    config.seconds = 1;
    config.liveBlocks = 32;
    assert(runner.Start(config));
    assert(!runner.Start(config));  // a second start while it runs is refused
    assert(WaitUntilFinished(runner, 20));
    const Report r = runner.Snapshot();
    assert(r.finished);
    assert(r.patternErrors == 0);
    assert(r.allocFailures == 0);
    assert(r.finalMutexLost == 0);
    assert(r.finalAtomicLost == 0);
    assert(r.finalSpinLost == 0);
    assert(r.mallocs > 1000);
    assert(r.frees == r.mallocs);  // every block is freed exactly once, a resize keeps the block
    assert(r.handoffs > 0);
    assert(r.iterations > 1000);

    char line[512];
    const size_t length = runner.Describe(line, sizeof(line));
    assert(length > 0 && length < sizeof(line));
    assert(std::strstr(line, "state=finished") != nullptr);
    assert(std::strstr(line, "firstError") == nullptr);

    // And it can run again once it has finished
    assert(runner.Start(config));
    assert(WaitUntilFinished(runner, 20));
    assert(runner.Snapshot().patternErrors == 0);
  }

  // A counter that is read, held for a moment and written back without the lock must lose updates, and the test
  // has to notice: this is what proves that a clean run means something
  {
    Runner runner;
    Config config;
    config.threads = 4;
    config.seconds = 1;
    config.modes = kMutexCounter;
    config.injectFault = 1;
    assert(runner.Start(config));
    assert(WaitUntilFinished(runner, 20));
    assert(runner.Snapshot().finalMutexLost > 0);
  }

  // A block that is damaged before it is verified must be caught, with the place of the first difference
  {
    Runner runner;
    Config config;
    config.threads = 2;
    config.seconds = 1;
    config.modes = kMalloc | kHandoff;
    config.liveBlocks = 16;
    config.injectFault = 2;
    assert(runner.Start(config));
    assert(WaitUntilFinished(runner, 20));
    const Report r = runner.Snapshot();
    assert(r.patternErrors > 0);
    char line[512];
    runner.Describe(line, sizeof(line));
    assert(std::strstr(line, "firstError[") != nullptr);
  }

  // The pause is what keeps the test from starving the TV: with a pause after every iteration the threads must stay
  // far below what they would do flat out
  {
    Runner runner;
    Config config;
    config.threads = 2;
    config.seconds = 1;
    config.pauseEvery = 1;
    config.pauseMicros = 5000;
    assert(runner.Start(config));
    assert(WaitUntilFinished(runner, 20));
    const Report r = runner.Snapshot();
    assert(r.iterations > 20);
    assert(r.iterations < 800);  // at most 2 threads * 1 s / 5 ms = 400, with room for a sleep that ends early
    assert(r.patternErrors == 0);
  }

  // Stopping early ends the run well before the configured time
  {
    Runner runner;
    Config config;
    config.threads = 2;
    config.seconds = 600;
    assert(runner.Start(config));
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    runner.RequestStop();
    assert(WaitUntilFinished(runner, 20));
    assert(runner.Snapshot().patternErrors == 0);
  }

  std::puts("alloc stress tests passed");
  return 0;
}
