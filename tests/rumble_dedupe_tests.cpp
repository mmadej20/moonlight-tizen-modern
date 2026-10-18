#include "wasm/rumble_dedupe.hpp"

#include <cassert>

int main() {
  RumbleDedupe dedupe;

  // Nothing vibrates at the start, so a stop for a controller that never started is not worth a message.
  assert(!dedupe.ShouldPost(0, 0, 0));

  // The first vibration is posted, the same values again are not.
  assert(dedupe.ShouldPost(0, 100, 200));
  assert(!dedupe.ShouldPost(0, 100, 200));
  assert(!dedupe.ShouldPost(0, 100, 200));

  // Any change in either motor is posted.
  assert(dedupe.ShouldPost(0, 101, 200));
  assert(dedupe.ShouldPost(0, 101, 7));

  // Controllers are independent.
  assert(dedupe.ShouldPost(1, 101, 7));
  assert(!dedupe.ShouldPost(1, 101, 7));
  assert(!dedupe.ShouldPost(0, 101, 7));

  // A stop is a change from vibrating, and a repeated stop is not posted.
  assert(dedupe.ShouldPost(0, 0, 0));
  assert(!dedupe.ShouldPost(0, 0, 0));
  assert(dedupe.ShouldPost(0, 5, 0));

  // A new stream forgets everything, so the first vibration of the next stream is posted even if it equals the last
  // one of the previous stream.
  dedupe.Reset();
  assert(dedupe.ShouldPost(0, 5, 0));
  dedupe.Reset();
  assert(!dedupe.ShouldPost(0, 0, 0));

  // Controller numbers outside of the table are always posted, so nothing is lost.
  assert(dedupe.ShouldPost(-1, 1, 1));
  assert(dedupe.ShouldPost(RumbleDedupe::kControllers, 1, 1));
  assert(dedupe.ShouldPost(RumbleDedupe::kControllers, 1, 1));

  return 0;
}
