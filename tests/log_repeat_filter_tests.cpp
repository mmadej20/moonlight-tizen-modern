#include "../wasm/log_repeat_filter.hpp"

#include <cassert>

int main() {
  {
    LogRepeatFilter filter;
    // The first message is always logged, and nothing was left out before it
    auto first = filter.Check("Input queue reached maximum size limit\n", 1000);
    assert(first.log && first.repeated == 0);

    // The same message within a second is left out, however often it comes
    for (int i = 0; i < 5000; i++) {
      assert(!filter.Check("Input queue reached maximum size limit\n", 1000 + (i % 900)).log);
    }

    // A different message is logged and says how many identical ones were left out before it
    auto other = filter.Check("Received first video packet after 300 ms\n", 1500);
    assert(other.log && other.repeated == 5000);

    // The count starts again
    auto again = filter.Check("Received first video packet after 300 ms\n", 1600);
    assert(!again.log);
    auto next = filter.Check("Starting audio stream...\n", 1700);
    assert(next.log && next.repeated == 1);
  }

  {
    // A message that goes on for longer than a second is logged once a second, with the count
    LogRepeatFilter filter;
    assert(filter.Check("busy\n", 0).log);
    assert(!filter.Check("busy\n", 400).log);
    assert(!filter.Check("busy\n", 999).log);
    auto second = filter.Check("busy\n", 1000);
    assert(second.log && second.repeated == 2);
    assert(!filter.Check("busy\n", 1500).log);
    auto third = filter.Check("busy\n", 2100);
    assert(third.log && third.repeated == 1);
  }

  {
    // Messages that merely look alike are different messages
    LogRepeatFilter filter;
    assert(filter.Check("stall 100 ms\n", 0).log);
    assert(filter.Check("stall 101 ms\n", 1).log);
    assert(filter.Check("stall 100 ms\n", 2).log);
  }

  return 0;
}
