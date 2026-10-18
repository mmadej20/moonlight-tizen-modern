#ifndef MOONLIGHT_WASM_CONNECTION_LIFECYCLE_HPP
#define MOONLIGHT_WASM_CONNECTION_LIFECYCLE_HPP

#include <atomic>
#include <mutex>
#include <utility>

enum class ConnectionState {
  Idle,
  Starting,
  Running,
  Stopping,
};

class ConnectionLifecycle {
 public:
  class StartGuard {
   public:
    StartGuard(StartGuard&&) = default;
    StartGuard& operator=(StartGuard&&) = default;

    StartGuard(const StartGuard&) = delete;
    StartGuard& operator=(const StartGuard&) = delete;

    explicit operator bool() const {
      return valid_;
    }

    void Release() {
      if (lock_.owns_lock()) {
        lock_.unlock();
      }
      valid_ = false;
    }

   private:
    friend class ConnectionLifecycle;

    StartGuard(std::unique_lock<std::mutex>&& lock, bool valid)
        : lock_(std::move(lock)), valid_(valid) {}

    std::unique_lock<std::mutex> lock_;
    bool valid_;
  };

  bool TryStart() {
    ConnectionState expected = ConnectionState::Idle;
    return state_.compare_exchange_strong(expected, ConnectionState::Starting);
  }

  StartGuard AcquireStartGuard() {
    std::unique_lock<std::mutex> lock(start_mutex_);
    const bool valid = state_.load() == ConnectionState::Starting;
    if (!valid) {
      lock.unlock();
    }
    return StartGuard(std::move(lock), valid);
  }

  bool MarkRunning() {
    ConnectionState expected = ConnectionState::Starting;
    return state_.compare_exchange_strong(expected, ConnectionState::Running);
  }

  bool BeginStop() {
    std::lock_guard<std::mutex> lock(start_mutex_);
    ConnectionState expected = state_.load();
    while (expected == ConnectionState::Starting ||
           expected == ConnectionState::Running) {
      if (state_.compare_exchange_strong(expected, ConnectionState::Stopping)) {
        return true;
      }
    }
    return false;
  }

  // A start failed before any thread or media source was created, so the slot goes back to idle
  bool AbortStart() {
    ConnectionState expected = ConnectionState::Starting;
    return state_.compare_exchange_strong(expected, ConnectionState::Idle);
  }

  bool MarkIdle() {
    ConnectionState expected = ConnectionState::Stopping;
    return state_.compare_exchange_strong(expected, ConnectionState::Idle);
  }

  ConnectionState state() const {
    return state_.load();
  }

 private:
  std::mutex start_mutex_;
  std::atomic<ConnectionState> state_{ConnectionState::Idle};
};

#endif
