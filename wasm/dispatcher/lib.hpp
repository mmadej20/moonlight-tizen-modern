#ifndef __DISPATCHER_LIB_HPP
#define __DISPATCHER_LIB_HPP

#include <cerrno>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <type_traits>

static void no_op() {}

class Entry {
  public:
  Entry()
      : end(false), cv(nullptr), mutex(nullptr), completed(nullptr),
        notify(true) {}
  ~Entry() = default;

  std::function<void(void)> func;
  bool end;
  std::condition_variable_any* cv;
  std::recursive_mutex* mutex;
  bool* completed;
  bool notify;
};

class DispatcherQueue {
  public:
  DispatcherQueue() = default;
  ~DispatcherQueue() = default;

  DispatcherQueue(const DispatcherQueue&) = delete;
  DispatcherQueue operator=(const DispatcherQueue&) = delete;

  void push(Entry&& entry) {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    queue_.emplace(std::move(entry));
    cv_.notify_one();
  }

  Entry pop() {
    std::lock_guard<std::recursive_mutex> lock(mutex_);
    Entry result = queue_.front();
    queue_.pop();
    return result;
  }

  bool wait() {
    std::unique_lock<std::recursive_mutex> lock(mutex_);
    if (!queue_.empty()) {
      return true;
    }

    cv_.wait(lock);
    return false;
  }

  private:
  std::queue<Entry> queue_;
  std::recursive_mutex mutex_;
  std::condition_variable_any cv_;
};

class Dispatcher {
  public:
  Dispatcher(const std::string& name) : name_(name) {}
  ~Dispatcher() { stop(); }

  Dispatcher(const Dispatcher&) = delete;
  Dispatcher operator=(const Dispatcher&) = delete;

  bool start() {
    std::unique_lock<std::mutex> lock(lifecycle_mutex_);
    lifecycle_cv_.wait(lock, [this] { return !join_in_progress_; });
    if (started_ || thread_.joinable()) {
      return false;
    }

    thread_ = std::thread([this] { this->dispatcher_func(); });
    started_ = true;
    accepting_ = true;
    stop_posted_ = false;
    return true;
  }

  void stop() {
    std::unique_lock<std::mutex> lock(lifecycle_mutex_);
    const bool isWorker =
      started_ && thread_.joinable() &&
      thread_.get_id() == std::this_thread::get_id();

    if (join_in_progress_) {
      if (isWorker) {
        return;
      }
      lifecycle_cv_.wait(lock, [this] { return !join_in_progress_; });
      return;
    }

    if (!started_) {
      return;
    }

    accepting_ = false;
    if (!stop_posted_) {
      Entry endEntry;
      endEntry.func = no_op;
      endEntry.end = true;
      endEntry.notify = false;
      queue_.push(std::move(endEntry));
      stop_posted_ = true;
    }

    if (isWorker) {
      return;
    }

    if (!thread_.joinable()) {
      started_ = false;
      stop_posted_ = false;
      lifecycle_cv_.notify_all();
      return;
    }

    join_in_progress_ = true;
    lock.unlock();
    thread_.join();
    lock.lock();

    started_ = false;
    accepting_ = false;
    stop_posted_ = false;
    join_in_progress_ = false;
    lifecycle_cv_.notify_all();
  }

  template <typename R, typename... Ts>
  R dispatch_method(std::recursive_mutex& thread_mutex, std::condition_variable_any& thread_cv, R (*method)(Ts...), bool end, Ts... ts) {
    if (end) {
      errno = EINVAL;
      if constexpr (!std::is_same<R, void>::value) {
        return R{};
      } else {
        return;
      }
    }

    if constexpr (std::is_same<R, void>::value) {
      Entry entry;
      int methodError = 0;
      bool completed = false;
      entry.func = [&]() {
        method(ts...);
        methodError = errno;
      };
      entry.mutex = &thread_mutex;
      entry.cv = &thread_cv;
      entry.completed = &completed;

      {
        std::unique_lock<std::recursive_mutex> lock(thread_mutex);
        if (!enqueue(std::move(entry))) {
          errno = ECANCELED;
          return;
        }
        thread_cv.wait(lock, [&completed] { return completed; });
      }

      errno = methodError;
      return;
    } else {
      R ret{};

      Entry entry;
      int methodError = 0;
      bool completed = false;
      entry.func = [&]() {
        ret = method(ts...);
        methodError = errno;
      };
      entry.mutex = &thread_mutex;
      entry.cv = &thread_cv;
      entry.completed = &completed;

      {
        std::unique_lock<std::recursive_mutex> lock(thread_mutex);
        if (!enqueue(std::move(entry))) {
          errno = ECANCELED;
          return R{};
        }
        thread_cv.wait(lock, [&completed] { return completed; });
      }

      errno = methodError;
      return ret;
    }
  }

  template<class Callable, typename... Ts>
  bool post_job(Callable&& fn, bool end, Ts... ts) {
    if (end) {
      return false;
    }

    Entry entry;
    entry.func = [=]() mutable {
      fn(ts...);
    };
    entry.notify = false;

    return enqueue(std::move(entry));
  }

  private:
  bool enqueue(Entry&& entry) {
    std::lock_guard<std::mutex> lock(lifecycle_mutex_);
    if (!started_ || !accepting_) {
      return false;
    }
    queue_.push(std::move(entry));
    return true;
  }

  void dispatcher_func() {
    bool running = true;
    while (running) {
      while (!queue_.wait()) {
      }
      Entry entry = queue_.pop();

      if (entry.end) {
        running = false;
      } else {
        entry.func();
      }

      if (entry.notify) {
        std::unique_lock<std::recursive_mutex> lock(*entry.mutex);
        *entry.completed = true;
        entry.cv->notify_one();
      }
    }
  }

  DispatcherQueue queue_;
  std::thread thread_;
  std::string name_;
  std::mutex lifecycle_mutex_;
  std::condition_variable lifecycle_cv_;
  bool started_{false};
  bool accepting_{false};
  bool stop_posted_{false};
  bool join_in_progress_{false};
};

class ThreadStorage {
  public:
  ThreadStorage() = default;
  ~ThreadStorage() = default;
  std::recursive_mutex mutex;
  std::condition_variable_any cv;
};

#endif
