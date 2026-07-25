#ifndef MOONLIGHT_WASM_OWNED_PTHREAD_HPP
#define MOONLIGHT_WASM_OWNED_PTHREAD_HPP

#include <cerrno>
#include <condition_variable>
#include <mutex>
#include <pthread.h>
#include <utility>

enum class PthreadOwnershipState {
  None,
  Creating,
  Created,
  Joining,
};

class OwnedPthread {
 public:
  using ThreadFunction = void* (*)(void*);

  OwnedPthread() = default;
  ~OwnedPthread() = default;

  OwnedPthread(const OwnedPthread&) = delete;
  OwnedPthread& operator=(const OwnedPthread&) = delete;

  int Create(ThreadFunction function, void* argument) {
    return CreateWith(
        function, argument,
        [](pthread_t* thread, const pthread_attr_t* attributes,
           ThreadFunction trampoline, void* context) {
          return pthread_create(thread, attributes, trampoline, context);
        });
  }

  template <typename Creator>
  int CreateWith(ThreadFunction function, void* argument, Creator&& creator) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (state_ != PthreadOwnershipState::None) {
        return EBUSY;
      }
      function_ = function;
      argument_ = argument;
      state_ = PthreadOwnershipState::Creating;
    }

    pthread_t createdThread{};
    const int result = creator(
        &createdThread, nullptr, &OwnedPthread::RunPublishedThread, this);

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (result == 0) {
        thread_ = createdThread;
        state_ = PthreadOwnershipState::Created;
      } else {
        function_ = nullptr;
        argument_ = nullptr;
        state_ = PthreadOwnershipState::None;
      }
    }
    state_cv_.notify_all();
    return result;
  }

  int Join() {
    pthread_t thread{};
    {
      std::unique_lock<std::mutex> lock(mutex_);
      state_cv_.wait(lock, [this] {
        return state_ != PthreadOwnershipState::Creating;
      });

      while (state_ == PthreadOwnershipState::Joining) {
        if (pthread_equal(thread_, pthread_self()) != 0) {
          return EDEADLK;
        }
        state_cv_.wait(lock, [this] {
          return state_ != PthreadOwnershipState::Joining;
        });
      }
      if (state_ == PthreadOwnershipState::None) {
        return 0;
      }

      thread = thread_;
      if (pthread_equal(thread, pthread_self()) != 0) {
        return EDEADLK;
      }
      state_ = PthreadOwnershipState::Joining;
    }

    const int result = pthread_join(thread, nullptr);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (result == 0) {
        thread_ = pthread_t{};
        function_ = nullptr;
        argument_ = nullptr;
        state_ = PthreadOwnershipState::None;
      } else {
        state_ = PthreadOwnershipState::Created;
      }
    }
    state_cv_.notify_all();
    return result;
  }

  PthreadOwnershipState state() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return state_;
  }

 private:
  static void* RunPublishedThread(void* rawOwner) {
    auto* owner = static_cast<OwnedPthread*>(rawOwner);
    ThreadFunction function = nullptr;
    void* argument = nullptr;
    {
      std::unique_lock<std::mutex> lock(owner->mutex_);
      owner->state_cv_.wait(lock, [owner] {
        return owner->state_ != PthreadOwnershipState::Creating;
      });
      if (owner->state_ == PthreadOwnershipState::None) {
        return nullptr;
      }
      function = owner->function_;
      argument = owner->argument_;
    }
    return function(argument);
  }

  mutable std::mutex mutex_;
  std::condition_variable state_cv_;
  PthreadOwnershipState state_{PthreadOwnershipState::None};
  pthread_t thread_{};
  ThreadFunction function_{nullptr};
  void* argument_{nullptr};
};

#endif
