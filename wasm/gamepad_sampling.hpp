#pragma once

#include <cstdint>

// The input thread asks the main thread for the state of the controllers. Every Emscripten call for that is a
// synchronous round trip to the main thread, and reading one slot at a time cost 2 + one call per slot (about 1200
// round trips per second with four slots), even when no controller was connected. One call that fills all the slots
// is enough, and without a controller there is little to look for.

struct GamepadSample {
  bool ok;
  int count;                 // number of slots the browser reports
  uint32_t presentMask;      // bit n is set when slot n holds a controller
  bool unavailable = false;  // the bulk call cannot work in this build, use the per-call API instead
};

// Decodes the answer of the main thread: the slot count in the low byte and the present mask above it. -1 means that
// the bulk call is not available in this build. Any other negative answer means that the browser threw while the
// controllers were read: the per-call API would throw the same way, so the poll is skipped and tried again later.
inline GamepadSample DecodeGamepadSample(int raw) {
  if (raw == -1) {
    return {false, 0, 0, true};
  }
  if (raw < 0) {
    return {false, 0, 0, false};
  }
  return {true, raw & 0xFF, static_cast<uint32_t>(raw >> 8) & 0xFFFFu, false};
}

inline bool GamepadSlotPresent(const GamepadSample& sample, int slot) {
  return slot >= 0 && slot < 16 && ((sample.presentMask >> slot) & 1u) != 0;
}

// Decides on which rounds of the input loop (one round is 5 ms) the controllers are polled.
class GamepadPollSchedule {
 public:
  static constexpr int kActiveEveryRounds = 1;  // a controller is in use: poll every 5 ms
  static constexpr int kIdleEveryRounds = 5;    // nothing connected: poll every 25 ms

  bool ShouldPoll() {
    if (m_RoundsToSkip > 0) {
      --m_RoundsToSkip;
      return false;
    }
    return true;
  }

  void Polled(bool controllerActive) {
    m_RoundsToSkip = (controllerActive ? kActiveEveryRounds : kIdleEveryRounds) - 1;
  }

 private:
  int m_RoundsToSkip = 0;
};

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/html5.h>

// Fills the slots of `events` that hold a controller and returns what DecodeGamepadSample understands: the number of
// slots in the low byte and a bit per filled slot above it, -1 when this build cannot do it, or -2 when the browser
// threw. It does the work of
// emscripten_sample_gamepad_data, emscripten_get_num_gamepads and emscripten_get_gamepad_status in a single call
// to the main thread. __fillGamepadEventData is the helper that emscripten_get_gamepad_status uses, so the layout of the
// slots is the one of EmscriptenGamepadEvent. Nothing may throw here: an exception in a call that the main thread
// runs for a worker would leave the worker waiting for good. The code must not contain comments or commas outside of
// parentheses, because the macro turns it into a single line of text.
inline int SampleGamepadSlots(EmscriptenGamepadEvent* events, int maxSlots) {
  return MAIN_THREAD_EM_ASM_INT({
    try {
      if (typeof __fillGamepadEventData !== 'function') {
        return -1;
      }
      var pads = navigator.getGamepads ? navigator.getGamepads() : (navigator.webkitGetGamepads ? navigator.webkitGetGamepads() : null);
      if (!pads) {
        return -1;
      }
      var count = Math.min(pads.length, $2);
      var mask = 0;
      for (var slot = 0; slot < count; ++slot) {
        var pad = pads[slot];
        if (pad) {
          __fillGamepadEventData($0 + slot * $1, pad);
          mask |= 1 << slot;
        }
      }
      return count | (mask << 8);
    } catch (error) {
      return -2;
    }
  }, events, static_cast<int>(sizeof(EmscriptenGamepadEvent)), maxSlots);
}
#endif
