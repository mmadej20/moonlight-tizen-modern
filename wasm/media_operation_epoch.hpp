#pragma once

#include <cstdint>
#include <mutex>
#include <utility>

class MediaOperationEpoch {
 public:
  struct Context {
    uint64_t epoch{0};
    const void* source{nullptr};
  };

  Context Begin(const void* source) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_Active = Context{++m_NextEpoch, source};
    return m_Active;
  }

  template <typename Callback>
  bool RunIfActive(const Context& context, Callback&& callback) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    if (!Matches(context)) {
      return false;
    }

    std::forward<Callback>(callback)();
    return true;
  }

  void Clear(const Context& context) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    if (Matches(context)) {
      m_Active = {};
    }
  }

 private:
  bool Matches(const Context& context) const {
    return context.epoch != 0 &&
           context.epoch == m_Active.epoch &&
           context.source == m_Active.source;
  }

  std::mutex m_Mutex;
  uint64_t m_NextEpoch{0};
  Context m_Active;
};
