#pragma once

#include <atomic>
#include <chrono>
#include <string>

// Returns only the path of a request URL. Diagnostic logs must never contain the host or the
// query string, because it carries the client id and, for launch and resume, the remote input key.
inline std::string HttpUrlPathForLog(const std::string& url) {
  std::size_t pathStart = 0;
  const std::size_t schemeEnd = url.find("://");
  if (schemeEnd != std::string::npos) {
    pathStart = url.find('/', schemeEnd + 3);
    if (pathStart == std::string::npos) {
      return "/";
    }
  }

  const std::size_t suffixStart = url.find_first_of("?#", pathStart);
  const std::string path = url.substr(
    pathStart, suffixStart == std::string::npos ? std::string::npos : suffixStart - pathStart);
  return path.empty() ? "/" : path;
}

// All HTTP requests share one dispatcher thread, so a slow request delays everything behind it.
// This tracks how many requests are queued and decides which delays are worth a log line.
class HttpQueueMetrics {
 public:
  // Called when a request is posted; returns how many requests are queued including this one
  int Enqueued() { return m_Depth.fetch_add(1) + 1; }

  // Called when the dispatcher starts a request; returns how many requests are still waiting
  int Started() { return m_Depth.fetch_sub(1) - 1; }

  int Depth() const { return m_Depth.load(); }

  static bool ShouldLogWait(std::chrono::milliseconds wait) {
    return wait >= std::chrono::milliseconds(1000);
  }

  static bool ShouldLogSlow(std::chrono::milliseconds duration) {
    return duration >= std::chrono::milliseconds(3000);
  }

 private:
  std::atomic<int> m_Depth{0};
};
