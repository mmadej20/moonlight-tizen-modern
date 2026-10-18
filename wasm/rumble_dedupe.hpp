#pragma once

// The host sends a rumble message every time the game changes the strength, up to 56 times per second, and often the
// values are the same as in the previous message. Each message used to cost a synchronous call into the interface
// on the thread of the control stream. A message that repeats the previous values of the controller carries
// nothing new, so it is not passed on.
class RumbleDedupe {
 public:
  static constexpr int kControllers = 16;

  // Whether the values differ from the last ones passed on for this controller. A controller number outside the
  // table is always passed on, so nothing can get lost.
  bool ShouldPost(int controller, unsigned short low, unsigned short high) {
    if (controller < 0 || controller >= kControllers) {
      return true;
    }
    Motors& last = m_Last[controller];
    if (last.low == low && last.high == high) {
      return false;
    }
    last.low = low;
    last.high = high;
    return true;
  }

  // Everything is silent again, as it is at the start of a stream
  void Reset() {
    for (Motors& last : m_Last) {
      last = Motors();
    }
  }

 private:
  struct Motors {
    unsigned short low = 0;
    unsigned short high = 0;
  };

  Motors m_Last[kControllers];
};
