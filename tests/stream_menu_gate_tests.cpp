#include "wasm/stream_menu_gate.hpp"

#include <cassert>
#include <cstdio>

namespace {

constexpr uint16_t kBack = StreamMenuGate::kSelectFlag;  // BACK_FLAG of Limelight.h
constexpr uint16_t kPlay = 0x0010;
constexpr uint16_t kLb = 0x0100;
constexpr uint16_t kRb = 0x0200;
constexpr uint16_t kX = 0x4000;
constexpr uint16_t kA = 0x1000;

using Decision = StreamMenuGate::SendDecision;

}  // namespace

int main() {
  // Select alone opens the menu after a second, once
  {
    StreamMenuGate gate;
    int64_t now = 10000;
    assert(!gate.UpdateHold(0, now, kBack));
    assert(!gate.UpdateHold(0, now + StreamMenuGate::kHoldMs - 1, kBack));
    assert(gate.UpdateHold(0, now + StreamMenuGate::kHoldMs, kBack));
    assert(gate.IsCaptured());
    // Held for a long time, it does not fire again, and a captured gate never fires
    assert(!gate.UpdateHold(0, now + 5000, kBack));
    assert(!gate.UpdateHold(0, now + 9000, kBack));
  }

  // A release and a new hold fire again, once the menu is closed
  {
    StreamMenuGate gate;
    assert(!gate.UpdateHold(0, 0, kBack));
    assert(gate.UpdateHold(0, 1000, kBack));
    gate.SetCaptured(false);
    assert(!gate.UpdateHold(0, 1100, 0));
    assert(!gate.UpdateHold(0, 2000, kBack));
    assert(!gate.UpdateHold(0, 2999, kBack));
    assert(gate.UpdateHold(0, 3000, kBack));
  }

  // Select that is still down when the menu is closed does not open it again: it has to be released first
  {
    StreamMenuGate gate;
    assert(!gate.UpdateHold(0, 0, kBack));
    assert(gate.UpdateHold(0, 1000, kBack));
    assert(!gate.UpdateHold(0, 1500, kBack));
    gate.SetCaptured(false);
    assert(!gate.UpdateHold(0, 1600, kBack));
    assert(!gate.UpdateHold(0, 2600, kBack));
    assert(!gate.UpdateHold(0, 9000, kBack));
    assert(!gate.UpdateHold(0, 9100, 0));
    assert(!gate.UpdateHold(0, 9200, kBack));
    assert(gate.UpdateHold(0, 10200, kBack));
  }

  // The combos of the stop and of the statistics hold Select with other buttons: they never open the menu
  {
    StreamMenuGate gate;
    const uint16_t stop = kBack | kPlay | kLb | kRb;
    const uint16_t stats = kBack | kLb | kRb | kX;
    for (int64_t now = 0; now <= 5000; now += 5) {
      assert(!gate.UpdateHold(0, now, stop));
      assert(!gate.UpdateHold(1, now, stats));
      assert(!gate.UpdateHold(2, now, kBack | kA));
    }
    assert(!gate.IsCaptured());
  }

  // A hold is counted from Select alone: another button pressed during it starts the count again
  {
    StreamMenuGate gate;
    assert(!gate.UpdateHold(0, 0, kBack));
    assert(!gate.UpdateHold(0, 900, kBack | kA));
    assert(!gate.UpdateHold(0, 950, kBack));
    assert(!gate.UpdateHold(0, 1900, kBack));
    assert(gate.UpdateHold(0, 1950, kBack));
  }

  // Every controller has its own clock, and the menu is one for all of them
  {
    StreamMenuGate gate;
    assert(!gate.UpdateHold(3, 100, kBack));
    assert(!gate.UpdateHold(3, 1099, kBack));
    assert(gate.UpdateHold(3, 1100, kBack));
  }
  {
    StreamMenuGate gate;
    assert(!gate.UpdateHold(0, 0, kBack));
    assert(!gate.UpdateHold(1, 400, kBack));
    assert(gate.UpdateHold(0, 1000, kBack));
    assert(!gate.UpdateHold(1, 1400, kBack));  // the menu is open already
    gate.SetCaptured(false);
    assert(!gate.UpdateHold(1, 3000, kBack));  // and its Select has to be released first
  }

  // A slot outside the range never opens the menu and never throws
  {
    StreamMenuGate gate;
    assert(!gate.UpdateHold(-1, 0, kBack));
    assert(!gate.UpdateHold(-1, 5000, kBack));
    assert(!gate.UpdateHold(StreamMenuGate::kMaxSlots, 0, kBack));
    assert(!gate.UpdateHold(StreamMenuGate::kMaxSlots, 5000, kBack));
    assert(gate.Decide(-1, kA) == Decision::Send);
    assert(gate.Decide(StreamMenuGate::kMaxSlots, kA) == Decision::Send);
  }

  // What goes to the host: everything, then one neutral state when the menu opens, then nothing
  {
    StreamMenuGate gate;
    assert(gate.Decide(0, kA) == Decision::Send);
    assert(gate.Decide(0, 0) == Decision::Send);
    gate.SetCaptured(true);
    assert(gate.Decide(0, 0) == Decision::SendNeutral);
    assert(gate.Decide(0, 0) == Decision::Skip);
    assert(gate.Decide(0, kA) == Decision::Skip);
    assert(gate.Decide(0, kBack) == Decision::Skip);
  }

  // After the menu: nothing until every button was released once, so that the B that closed it does not reach the game
  {
    StreamMenuGate gate;
    gate.SetCaptured(true);
    assert(gate.Decide(0, kBack) == Decision::SendNeutral);
    gate.SetCaptured(false);
    assert(gate.Decide(0, kA) == Decision::Skip);
    assert(gate.Decide(0, kA | kLb) == Decision::Skip);
    assert(gate.Decide(0, 0) == Decision::Send);
    assert(gate.Decide(0, kA) == Decision::Send);
  }

  // Closed with the buttons already up: the input goes on at once
  {
    StreamMenuGate gate;
    gate.SetCaptured(true);
    assert(gate.Decide(0, 0) == Decision::SendNeutral);
    gate.SetCaptured(false);
    assert(gate.Decide(0, 0) == Decision::Send);
  }

  // The menu opened again while a pad was still waiting for its release
  {
    StreamMenuGate gate;
    gate.SetCaptured(true);
    assert(gate.Decide(0, kA) == Decision::SendNeutral);
    gate.SetCaptured(false);
    assert(gate.Decide(0, kA) == Decision::Skip);
    gate.SetCaptured(true);
    assert(gate.Decide(0, kA) == Decision::Skip);
    gate.SetCaptured(false);
    assert(gate.Decide(0, kA) == Decision::Skip);
    assert(gate.Decide(0, 0) == Decision::Send);
  }

  // A controller that joins while the menu is open gets its neutral state too, and the others are not affected
  {
    StreamMenuGate gate;
    gate.SetCaptured(true);
    assert(gate.Decide(0, 0) == Decision::SendNeutral);
    assert(gate.Decide(1, 0) == Decision::SendNeutral);
    assert(gate.Decide(0, 0) == Decision::Skip);
    assert(gate.Decide(1, 0) == Decision::Skip);
  }

  std::puts("stream_menu_gate_tests: PASS");
  return 0;
}
