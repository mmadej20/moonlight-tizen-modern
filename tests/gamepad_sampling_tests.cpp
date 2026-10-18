#include "wasm/gamepad_sampling.hpp"

#include <cassert>

int main() {
  // The main thread answers one call with the number of slots and a bit per slot that holds a controller.
  const GamepadSample none = DecodeGamepadSample(4);
  assert(none.ok && none.count == 4 && none.presentMask == 0);

  const GamepadSample two = DecodeGamepadSample(4 | (0b0101 << 8));
  assert(two.ok && two.count == 4 && two.presentMask == 0b0101);
  assert(GamepadSlotPresent(two, 0) && !GamepadSlotPresent(two, 1) && GamepadSlotPresent(two, 2));
  assert(!GamepadSlotPresent(two, 16) && !GamepadSlotPresent(two, -1));

  // The largest answer: sixteen slots, all present.
  const GamepadSample all = DecodeGamepadSample(16 | (0xFFFF << 8));
  assert(all.ok && all.count == 16 && all.presentMask == 0xFFFF);

  // -1 means the bulk call is not available in this build, so the caller falls back to the per-call API.
  assert(!DecodeGamepadSample(-1).ok && DecodeGamepadSample(-1).unavailable);

  // -2 means the browser threw while it was read. The per-call API would throw the same way in a call that the main
  // thread runs for the worker, so there is nothing to fall back to: the poll is skipped and tried again later.
  assert(!DecodeGamepadSample(-2).ok && !DecodeGamepadSample(-2).unavailable);
  assert(!DecodeGamepadSample(-7).ok && !DecodeGamepadSample(-7).unavailable);
  assert(!none.unavailable && !two.unavailable);

  // With a controller the input thread polls on every round (every 5 ms) ...
  GamepadPollSchedule schedule;
  for (int round = 0; round < 6; ++round) {
    assert(schedule.ShouldPoll());
    schedule.Polled(true);
  }

  // ... without one it asks the main thread only on every fifth round (25 ms), which is still instant for a person
  // who connects a controller but saves four of five synchronous calls to the main thread.
  schedule.Polled(false);
  int polls = 0;
  for (int round = 0; round < 20; ++round) {
    if (schedule.ShouldPoll()) {
      ++polls;
      schedule.Polled(false);
    }
  }
  assert(polls == 4);

  // The first round after a stream starts polls at once, and a controller that shows up speeds the polling up again.
  GamepadPollSchedule fresh;
  assert(fresh.ShouldPoll());
  fresh.Polled(false);
  for (int round = 0; round < GamepadPollSchedule::kIdleEveryRounds - 1; ++round) {
    assert(!fresh.ShouldPoll());
  }
  assert(fresh.ShouldPoll());
  fresh.Polled(true);
  assert(fresh.ShouldPoll());

  return 0;
}
