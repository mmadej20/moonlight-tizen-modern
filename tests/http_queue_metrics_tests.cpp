#include "wasm/http_queue_metrics.hpp"

#include <cassert>
#include <chrono>
#include <string>

using namespace std::chrono_literals;

int main() {
  // Only the path of a request may reach the diagnostic log: the query string carries
  // the client id and, for launch requests, the remote input key.
  assert(HttpUrlPathForLog("https://192.168.0.5:47984/serverinfo?uniqueid=abc&uuid=1") == "/serverinfo");
  assert(HttpUrlPathForLog("http://host.local:47989/appasset?uniqueid=a&appid=7&AssetType=2") == "/appasset");
  assert(HttpUrlPathForLog("https://[fe80::1]:47984/resume?rikey=SECRET&rikeyid=5") == "/resume");
  assert(HttpUrlPathForLog("https://host/launch#fragment") == "/launch");
  assert(HttpUrlPathForLog("https://host") == "/");
  assert(HttpUrlPathForLog("/serverinfo?x=1") == "/serverinfo");
  assert(HttpUrlPathForLog("") == "/");
  assert(HttpUrlPathForLog("https://host:47984/resume?rikey=SECRET").find("SECRET") == std::string::npos);

  // The queue depth counts requests that were posted but have not started yet.
  HttpQueueMetrics metrics;
  assert(metrics.Depth() == 0);
  assert(metrics.Enqueued() == 1);
  assert(metrics.Enqueued() == 2);
  assert(metrics.Enqueued() == 3);
  assert(metrics.Depth() == 3);
  assert(metrics.Started() == 2);  // two requests are still waiting behind the one that started
  assert(metrics.Started() == 1);
  assert(metrics.Started() == 0);
  assert(metrics.Depth() == 0);

  // A request that waits at least one second in the queue is worth a log line.
  assert(!HttpQueueMetrics::ShouldLogWait(0ms));
  assert(!HttpQueueMetrics::ShouldLogWait(999ms));
  assert(HttpQueueMetrics::ShouldLogWait(1000ms));
  assert(HttpQueueMetrics::ShouldLogWait(45s));

  // A request that runs for at least three seconds is logged as slow.
  assert(!HttpQueueMetrics::ShouldLogSlow(2999ms));
  assert(HttpQueueMetrics::ShouldLogSlow(3000ms));

  return 0;
}
