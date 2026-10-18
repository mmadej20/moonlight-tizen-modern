#include "wasm/controller_send_filter.hpp"

#include <cassert>

namespace {

ControllerState Idle() {
  return ControllerState{0, 0, 0, 0, 0, 0, 0, 1};
}

}  // namespace

int main() {
  ControllerSendFilter filter;

  // The first state of a controller is always sent: the host knows nothing about it yet.
  assert(filter.ShouldSend(0, Idle(), 1000));

  // The same state again is not sent, however often it is polled.
  for (int64_t now = 1005; now < 1090; now += 5) {
    assert(!filter.ShouldSend(0, Idle(), now));
  }

  // But the host is reminded at the keep-alive interval, so a lost or reset state on the host heals by itself.
  assert(filter.ShouldSend(0, Idle(), 1000 + ControllerSendFilter::kKeepAliveMs));
  assert(!filter.ShouldSend(0, Idle(), 1000 + ControllerSendFilter::kKeepAliveMs + 5));

  // Every kind of change is sent at once.
  int64_t now = 2000;
  assert(filter.ShouldSend(0, Idle(), now));  // the reminder above moved the clock, this one is a keep-alive again
  ControllerState state = Idle();
  state.buttonFlags = 0x1000;
  assert(filter.ShouldSend(0, state, now += 5));
  assert(!filter.ShouldSend(0, state, now += 5));
  state.leftTrigger = 200;
  assert(filter.ShouldSend(0, state, now += 5));
  state.rightTrigger = 1;
  assert(filter.ShouldSend(0, state, now += 5));
  state.leftStickX = -32767;
  assert(filter.ShouldSend(0, state, now += 5));
  state.leftStickY = 12;
  assert(filter.ShouldSend(0, state, now += 5));
  state.rightStickX = 1;
  assert(filter.ShouldSend(0, state, now += 5));
  state.rightStickY = -1;
  assert(filter.ShouldSend(0, state, now += 5));
  state.activeMask = 3;  // another controller joined: the host needs the new mask even if nothing else moved
  assert(filter.ShouldSend(0, state, now += 5));
  assert(!filter.ShouldSend(0, state, now += 5));

  // Slots are independent.
  ControllerSendFilter two;
  assert(two.ShouldSend(0, Idle(), 5000));
  assert(two.ShouldSend(1, Idle(), 5000));
  assert(!two.ShouldSend(0, Idle(), 5005));
  assert(!two.ShouldSend(1, Idle(), 5005));
  ControllerState moved = Idle();
  moved.rightStickX = 100;
  assert(two.ShouldSend(1, moved, 5010));
  assert(!two.ShouldSend(0, Idle(), 5010));

  // A controller that left or arrived again, or a new stream, starts over: the next state is sent at once.
  two.Reset(0);
  assert(two.ShouldSend(0, Idle(), 5015));
  assert(!two.ShouldSend(1, moved, 5015));
  two.ResetAll();
  assert(two.ShouldSend(0, Idle(), 5020));
  assert(two.ShouldSend(1, moved, 5020));

  // Slots outside the range never block or crash the caller.
  assert(two.ShouldSend(-1, Idle(), 6000));
  assert(two.ShouldSend(ControllerSendFilter::kSlots, Idle(), 6000));

  // The keep-alive survives the wrap of the 32-bit millisecond clock.
  ControllerSendFilter wrap;
  assert(wrap.ShouldSend(0, Idle(), 4294967290LL));
  assert(!wrap.ShouldSend(0, Idle(), 4294967296LL + 40));
  assert(wrap.ShouldSend(0, Idle(), 4294967296LL + 120));

  return 0;
}
