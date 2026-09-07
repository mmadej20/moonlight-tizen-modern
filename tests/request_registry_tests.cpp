#include "wasm/request_registry.hpp"

#include <cassert>

int main() {
  HttpRequestRegistry registry;
  auto first = registry.Create(41, 3000, 5000);
  auto second = registry.Create(42, 3000, 10000);
  assert(first && second && registry.Size() == 2);
  assert(registry.Cancel(41));
  assert(http_request_is_cancelled(first.get()));
  assert(!http_request_is_cancelled(second.get()));
  assert(!registry.Cancel(999));
  registry.Remove(41);
  assert(registry.Size() == 1);
  registry.Remove(42);
  assert(registry.Size() == 0);
  auto pairing = registry.Create(43, 3000, 0);
  assert(pairing->connect_timeout_ms == 3000);
  assert(pairing->total_timeout_ms == 0);
  assert(pairing->low_speed_time_seconds == 0);
  assert(pairing->low_speed_bytes_per_second == 0);
  auto normal = registry.Create(44, 3000, 5000);
  assert(normal->total_timeout_ms == 5000);
  assert(normal->low_speed_time_seconds == 2);
  assert(normal->low_speed_bytes_per_second == 1);
  assert(registry.Cancel(43));
  assert(!http_request_is_cancelled(normal.get()));
  registry.Remove(43);
  registry.Remove(44);
  assert(registry.Size() == 0);
  return 0;
}
