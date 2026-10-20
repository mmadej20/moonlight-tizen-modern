#ifndef MOONLIGHT_WASM_ALLOC_STRESS_HPP
#define MOONLIGHT_WASM_ALLOC_STRESS_HPP

// Allocator and lock stress test for the TV (docs/2026-10-18-stream-hang-investigation.md, section 10).
//
// The freezes of a long stream come from the malloc lock being left locked with no owner, or from a thread trapping
// inside malloc()/free() on a heap whose metadata was damaged. This runs the same primitives without any Moonlight
// logic, so a failure here belongs to the platform and the toolchain and not to the streaming code:
//   - a std::mutex (the same pthread mutex that guards dlmalloc) around a read-modify-write that is not atomic itself,
//   - a 32-bit atomic counter,
//   - a spin lock built on an exchange, around the same kind of read-modify-write,
//   - malloc/realloc/free of blocks of the sizes the stream uses, each filled with a pattern and verified before it
//     is freed, with part of the blocks freed by another thread than the one that allocated them.
// Every counter is 32-bit: the toolchain lowers 64-bit atomics wrongly (see stream_health.hpp).

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <thread>
#include <vector>

namespace allocstress {

enum Mode : uint32_t {
  kMutexCounter = 1,
  kAtomicCounter = 2,
  kSpinCounter = 4,
  kMalloc = 8,
  kHandoff = 16,
  kAll = 31,
};

struct Config {
  int threads = 8;
  int seconds = 60;
  uint32_t modes = kAll;
  int liveBlocks = 128;
  // Every thread sleeps pauseMicros after pauseEvery iterations. The stream's threads mostly wait for packets; threads
  // that never wait starve the main thread and the TV's own network handling (12 busy threads froze a TV for good)
  int pauseEvery = 8;
  int pauseMicros = 500;
  // Test only: 1 = the mutex counter runs without the lock, 2 = one block in 1024 is damaged before it is verified
  int injectFault = 0;
};

struct Report {
  const char* state = "idle";
  uint32_t elapsedSeconds = 0;
  int threads = 0;
  uint32_t iterations = 0;
  uint32_t mallocs = 0;
  uint32_t reallocs = 0;
  uint32_t frees = 0;
  uint32_t handoffs = 0;
  uint32_t patternErrors = 0;
  uint32_t allocFailures = 0;
  // Global counter minus the sum of what the threads counted themselves; it stays within a few units of zero
  // while the test runs and must be exactly zero at the end
  int32_t mutexDiff = 0;
  int32_t atomicDiff = 0;
  int32_t spinDiff = 0;
  uint32_t maxIdleMs = 0;
  bool finished = false;
  // Exact comparison after every thread was joined
  int32_t finalMutexLost = 0;
  int32_t finalAtomicLost = 0;
  int32_t finalSpinLost = 0;
};

inline uint32_t NowLow32Ms() {
  return static_cast<uint32_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
                                   std::chrono::steady_clock::now().time_since_epoch())
                                   .count());
}

inline uint8_t PatternByte(uint32_t seed, uint32_t index) {
  uint32_t x = seed ^ (index * 2654435761u);
  x ^= x >> 15;
  x *= 2246822519u;
  x ^= x >> 13;
  return static_cast<uint8_t>(x);
}

inline void FillBlock(uint8_t* data, uint32_t size, uint32_t seed) {
  for (uint32_t i = 0; i < size; ++i) data[i] = PatternByte(seed, i);
}

// Returns the offset of the first byte that differs, or -1
inline int64_t FirstMismatch(const uint8_t* data, uint32_t size, uint32_t seed) {
  for (uint32_t i = 0; i < size; ++i) {
    if (data[i] != PatternByte(seed, i)) return i;
  }
  return -1;
}

class Runner {
 public:
  Runner() = default;
  ~Runner() {
    RequestStop();
    JoinAll();
  }
  Runner(const Runner&) = delete;
  Runner& operator=(const Runner&) = delete;

  bool Start(const Config& config) {
    std::lock_guard<std::mutex> lifecycle(lifecycle_);
    if (state_.load() == kRunning) return false;
    JoinAllLocked();
    config_ = config;
    if (config_.threads < 1) config_.threads = 1;
    if (config_.threads > kMaxThreads) config_.threads = kMaxThreads;
    if (config_.liveBlocks < 1) config_.liveBlocks = 1;
    ResetCounters();
    startedMs_ = NowLow32Ms();
    stop_.store(false);
    state_.store(kRunning);
    for (int i = 0; i < config_.threads; ++i) {
      stats_[i].lastProgressMs.store(startedMs_, std::memory_order_relaxed);
    }
    for (int i = 0; i < config_.threads; ++i) {
      workers_.emplace_back([this, i] { Worker(i); });
    }
    coordinator_ = std::thread([this] { Coordinate(); });
    return true;
  }

  void RequestStop() { stop_.store(true); }

  bool Running() const { return state_.load() == kRunning; }
  bool Finished() const { return state_.load() == kFinished; }

  // Takes no lock and allocates nothing, so it keeps working when the allocator is the thing that hangs
  Report Snapshot() const {
    Report r;
    const int state = state_.load();
    r.state = state == kRunning ? "running" : (state == kFinished ? "finished" : "idle");
    r.finished = state == kFinished;
    r.threads = config_.threads;
    if (state == kIdle) return r;
    const uint32_t now = NowLow32Ms();
    r.elapsedSeconds = (r.finished ? endedMs_ : now) - startedMs_;
    r.elapsedSeconds /= 1000;
    uint32_t localMutex = 0, localAtomic = 0, localSpin = 0;
    uint32_t oldest = 0;
    for (int i = 0; i < config_.threads; ++i) {
      const ThreadStats& s = stats_[i];
      r.iterations += s.iterations.load(std::memory_order_relaxed);
      r.mallocs += s.mallocs.load(std::memory_order_relaxed);
      r.reallocs += s.reallocs.load(std::memory_order_relaxed);
      r.frees += s.frees.load(std::memory_order_relaxed);
      r.handoffs += s.handoffs.load(std::memory_order_relaxed);
      r.allocFailures += s.allocFailures.load(std::memory_order_relaxed);
      localMutex += s.localMutex.load(std::memory_order_relaxed);
      localAtomic += s.localAtomic.load(std::memory_order_relaxed);
      localSpin += s.localSpin.load(std::memory_order_relaxed);
      const uint32_t idle = now - s.lastProgressMs.load(std::memory_order_relaxed);
      if (idle > oldest) oldest = idle;
    }
    r.patternErrors = patternErrors_.load(std::memory_order_relaxed);
    r.mutexDiff = static_cast<int32_t>(mutexCounter_.load(std::memory_order_relaxed) - localMutex);
    r.atomicDiff = static_cast<int32_t>(atomicCounter_.load(std::memory_order_relaxed) - localAtomic);
    r.spinDiff = static_cast<int32_t>(spinCounter_.load(std::memory_order_relaxed) - localSpin);
    r.maxIdleMs = r.finished ? 0 : oldest;
    r.finalMutexLost = finalMutexLost_.load(std::memory_order_relaxed);
    r.finalAtomicLost = finalAtomicLost_.load(std::memory_order_relaxed);
    r.finalSpinLost = finalSpinLost_.load(std::memory_order_relaxed);
    return r;
  }

  // One line for the log and for the inspector; allocation free
  size_t Describe(char* out, size_t capacity) const {
    const Report r = Snapshot();
    char firstError[sizeof(firstError_)] = {0};
    // try_lock: a worker that is stuck must never be able to hold the report back
    if (errorMutex_.try_lock()) {
      std::snprintf(firstError, sizeof(firstError), "%s", firstError_);
      errorMutex_.unlock();
    }
    int written = std::snprintf(
        out, capacity,
        "state=%s elapsed=%us threads=%d iter=%u malloc=%u realloc=%u free=%u handoff=%u patternErrors=%u allocFail=%u "
        "mutexDiff=%d atomicDiff=%d spinDiff=%d maxIdleMs=%u final[mutexLost=%d atomicLost=%d spinLost=%d]%s",
        r.state, static_cast<unsigned>(r.elapsedSeconds), r.threads, static_cast<unsigned>(r.iterations),
        static_cast<unsigned>(r.mallocs), static_cast<unsigned>(r.reallocs), static_cast<unsigned>(r.frees),
        static_cast<unsigned>(r.handoffs), static_cast<unsigned>(r.patternErrors), static_cast<unsigned>(r.allocFailures),
        static_cast<int>(r.mutexDiff), static_cast<int>(r.atomicDiff), static_cast<int>(r.spinDiff),
        static_cast<unsigned>(r.maxIdleMs), static_cast<int>(r.finalMutexLost), static_cast<int>(r.finalAtomicLost),
        static_cast<int>(r.finalSpinLost), firstError);
    return written < 0 ? 0 : static_cast<size_t>(written);
  }

 private:
  static constexpr int kMaxThreads = 32;
  static constexpr int kRingSize = 1024;
  static constexpr int kIdle = 0;
  static constexpr int kRunning = 1;
  static constexpr int kFinished = 2;

  struct Block {
    uint8_t* data = nullptr;
    uint32_t size = 0;
    uint32_t seed = 0;
  };

  struct ThreadStats {
    std::atomic<uint32_t> iterations{0};
    std::atomic<uint32_t> mallocs{0};
    std::atomic<uint32_t> reallocs{0};
    std::atomic<uint32_t> frees{0};
    std::atomic<uint32_t> handoffs{0};
    std::atomic<uint32_t> allocFailures{0};
    std::atomic<uint32_t> localMutex{0};
    std::atomic<uint32_t> localAtomic{0};
    std::atomic<uint32_t> localSpin{0};
    std::atomic<uint32_t> lastProgressMs{0};
  };

  // The owner is the only writer, so a load and a store is enough and keeps the counter free of read-modify-write
  static void Bump(std::atomic<uint32_t>& counter) {
    counter.store(counter.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
  }

  static uint32_t NextRandom(uint32_t& state) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
  }

  // Roughly the mix of the stream: small ENet and queue entries, RTP packets, the odd large buffer
  static uint32_t PickSize(uint32_t random) {
    const uint32_t bucket = random % 100;
    const uint32_t value = random >> 8;
    if (bucket < 40) return 16 + value % 48;
    if (bucket < 80) return 64 + value % 448;
    if (bucket < 95) return 512 + value % 1100;
    return 1600 + value % 6600;
  }

  void ResetCounters() {
    for (int i = 0; i < kMaxThreads; ++i) {
      ThreadStats& s = stats_[i];
      s.iterations.store(0);
      s.mallocs.store(0);
      s.reallocs.store(0);
      s.frees.store(0);
      s.handoffs.store(0);
      s.allocFailures.store(0);
      s.localMutex.store(0);
      s.localAtomic.store(0);
      s.localSpin.store(0);
      s.lastProgressMs.store(0);
    }
    mutexCounter_.store(0);
    atomicCounter_.store(0);
    spinCounter_.store(0);
    spinFlag_.store(0);
    patternErrors_.store(0);
    finalMutexLost_.store(0);
    finalAtomicLost_.store(0);
    finalSpinLost_.store(0);
    ringHead_ = ringTail_ = ringCount_ = 0;
    errorCount_ = 0;
    firstError_[0] = '\0';
    endedMs_ = 0;
  }

  void RecordError(int thread, const char* where, uint32_t size, int64_t offset, uint8_t expected, uint8_t found) {
    patternErrors_.fetch_add(1, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lock(errorMutex_);
    if (errorCount_++ == 0) {
      std::snprintf(firstError_, sizeof(firstError_), " firstError[thread=%d where=%s size=%u offset=%d expected=%02x found=%02x]",
                    thread, where, static_cast<unsigned>(size), static_cast<int>(offset), expected, found);
    }
  }

  bool CheckAndFree(int thread, const char* where, Block& block, ThreadStats& stats) {
    bool ok = true;
    const int64_t bad = FirstMismatch(block.data, block.size, block.seed);
    if (bad >= 0) {
      RecordError(thread, where, block.size, bad, PatternByte(block.seed, static_cast<uint32_t>(bad)), block.data[bad]);
      ok = false;
    }
    std::free(block.data);
    Bump(stats.frees);
    block = Block{};
    return ok;
  }

  bool PushRing(const Block& block) {
    std::lock_guard<std::mutex> lock(ringMutex_);
    if (ringCount_ == kRingSize) return false;
    ring_[ringHead_] = block;
    ringHead_ = (ringHead_ + 1) % kRingSize;
    ++ringCount_;
    return true;
  }

  bool PopRing(Block& block) {
    std::lock_guard<std::mutex> lock(ringMutex_);
    if (ringCount_ == 0) return false;
    block = ring_[ringTail_];
    ringTail_ = (ringTail_ + 1) % kRingSize;
    --ringCount_;
    return true;
  }

  void Worker(int index) {
    ThreadStats& stats = stats_[index];
    const uint32_t modes = config_.modes;
    uint32_t random = ((0x9E3779B9u * static_cast<uint32_t>(index + 1)) ^ NowLow32Ms()) | 1u;
    std::vector<Block> live(static_cast<size_t>(config_.liveBlocks));
    uint32_t serial = 0;
    uint32_t round = 0;

    while (!stop_.load(std::memory_order_relaxed)) {
      if (modes & kMutexCounter) {
        if (config_.injectFault == 1) {
          const uint32_t value = mutexCounter_.load(std::memory_order_relaxed);
          if ((value & 3) == 0) std::this_thread::yield();
          mutexCounter_.store(value + 1, std::memory_order_relaxed);
        } else {
          std::lock_guard<std::mutex> lock(counterMutex_);
          mutexCounter_.store(mutexCounter_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
        }
        Bump(stats.localMutex);
      }
      if (modes & kAtomicCounter) {
        atomicCounter_.fetch_add(1, std::memory_order_relaxed);
        Bump(stats.localAtomic);
      }
      if (modes & kSpinCounter) {
        uint32_t spins = 0;
        while (spinFlag_.exchange(1, std::memory_order_acquire) != 0) {
          if ((++spins & 63) == 0) std::this_thread::yield();
        }
        spinCounter_.store(spinCounter_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
        spinFlag_.store(0, std::memory_order_release);
        Bump(stats.localSpin);
      }
      if (modes & kMalloc) {
        Block& slot = live[NextRandom(random) % live.size()];
        if (slot.data != nullptr) CheckAndFree(index, "own", slot, stats);

        const uint32_t size = PickSize(NextRandom(random));
        uint8_t* data = static_cast<uint8_t*>(std::malloc(size));
        if (data == nullptr) {
          Bump(stats.allocFailures);
        } else {
          Bump(stats.mallocs);
          const uint32_t seed = (++serial * 2654435761u) ^ (static_cast<uint32_t>(index) << 24) ^ size;
          FillBlock(data, size, seed);
          if (config_.injectFault == 2 && (serial & 1023u) == 0) data[size / 2] ^= 0xFF;
          slot = Block{data, size, seed};

          // Resize one block in 32 the way a growing buffer does; the old content must survive
          if ((NextRandom(random) & 31u) == 0) {
            const uint32_t newSize = PickSize(NextRandom(random));
            const uint32_t keep = newSize < size ? newSize : size;
            uint8_t* grown = static_cast<uint8_t*>(std::realloc(slot.data, newSize));
            if (grown == nullptr) {
              Bump(stats.allocFailures);
            } else {
              Bump(stats.reallocs);
              const int64_t bad = FirstMismatch(grown, keep, slot.seed);
              if (bad >= 0) RecordError(index, "realloc", keep, bad, PatternByte(slot.seed, static_cast<uint32_t>(bad)), grown[bad]);
              slot.data = grown;
              slot.size = newSize;
              FillBlock(slot.data, slot.size, slot.seed);
            }
          }

          // A quarter of the blocks leave through the ring and are freed by whichever thread takes them,
          // like a packet that one thread receives and another thread consumes
          if ((modes & kHandoff) && (NextRandom(random) & 3u) == 0) {
            if (PushRing(slot)) {
              Bump(stats.handoffs);
              slot = Block{};
            }
          }
        }
        if (modes & kHandoff) {
          Block taken;
          if (PopRing(taken)) CheckAndFree(index, "handoff", taken, stats);
        }
      }

      Bump(stats.iterations);
      ++round;
      if ((round & 63u) == 0) {
        stats.lastProgressMs.store(NowLow32Ms(), std::memory_order_relaxed);
        std::this_thread::yield();
      }
      // Leave the cores to the main thread now and then, as the real threads wait for packets
      if (config_.pauseEvery > 0 && config_.pauseMicros > 0 && round % static_cast<uint32_t>(config_.pauseEvery) == 0) {
        std::this_thread::sleep_for(std::chrono::microseconds(config_.pauseMicros));
      }
    }

    for (Block& block : live) {
      if (block.data != nullptr) CheckAndFree(index, "final", block, stats);
    }
    stats.lastProgressMs.store(NowLow32Ms(), std::memory_order_relaxed);
  }

  void Coordinate() {
    const uint32_t deadline = startedMs_ + static_cast<uint32_t>(config_.seconds) * 1000u;
    while (!stop_.load() && static_cast<int32_t>(NowLow32Ms() - deadline) < 0) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    stop_.store(true);
    for (std::thread& worker : workers_) worker.join();
    workers_.clear();

    // Whatever is still in the ring was handed off but not taken
    Block leftover;
    ThreadStats& drain = stats_[0];
    while (PopRing(leftover)) CheckAndFree(0, "drain", leftover, drain);

    uint32_t localMutex = 0, localAtomic = 0, localSpin = 0;
    for (int i = 0; i < config_.threads; ++i) {
      localMutex += stats_[i].localMutex.load();
      localAtomic += stats_[i].localAtomic.load();
      localSpin += stats_[i].localSpin.load();
    }
    finalMutexLost_.store(static_cast<int32_t>(localMutex - mutexCounter_.load()));
    finalAtomicLost_.store(static_cast<int32_t>(localAtomic - atomicCounter_.load()));
    finalSpinLost_.store(static_cast<int32_t>(localSpin - spinCounter_.load()));
    endedMs_ = NowLow32Ms();
    state_.store(kFinished);
  }

  void JoinAll() {
    std::lock_guard<std::mutex> lifecycle(lifecycle_);
    JoinAllLocked();
  }

  void JoinAllLocked() {
    if (coordinator_.joinable()) coordinator_.join();
    for (std::thread& worker : workers_) {
      if (worker.joinable()) worker.join();
    }
    workers_.clear();
  }

  Config config_;
  std::mutex lifecycle_;
  std::atomic<int> state_{kIdle};
  std::atomic<bool> stop_{false};
  uint32_t startedMs_ = 0;
  uint32_t endedMs_ = 0;
  std::vector<std::thread> workers_;
  std::thread coordinator_;
  ThreadStats stats_[kMaxThreads];

  std::mutex counterMutex_;
  std::atomic<uint32_t> mutexCounter_{0};
  std::atomic<uint32_t> atomicCounter_{0};
  std::atomic<int> spinFlag_{0};
  std::atomic<uint32_t> spinCounter_{0};
  std::atomic<int32_t> finalMutexLost_{0};
  std::atomic<int32_t> finalAtomicLost_{0};
  std::atomic<int32_t> finalSpinLost_{0};
  std::atomic<uint32_t> patternErrors_{0};

  std::mutex ringMutex_;
  Block ring_[kRingSize];
  int ringHead_ = 0;
  int ringTail_ = 0;
  int ringCount_ = 0;

  mutable std::mutex errorMutex_;
  uint32_t errorCount_ = 0;
  char firstError_[160] = {0};
};

}  // namespace allocstress

#endif
