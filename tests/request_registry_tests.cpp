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
  return 0;
}
