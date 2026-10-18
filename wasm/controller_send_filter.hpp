#pragma once

#include <cstdint>

// The input thread reads the controllers every 5-9 ms and used to send the state to the host every time: about 110
// encrypted reliable packets per second per controller, also while nothing moved. The host keeps the last state,
// so only a change has to be sent, plus a reminder now and then so that a state that was lost or reset on the host
// heals by itself.

struct ControllerState {
  int buttonFlags;
  unsigned char leftTrigger;
  unsigned char rightTrigger;
  short leftStickX;
  short leftStickY;
  short rightStickX;
  short rightStickY;
  short activeMask;  // the controllers that are connected, which changes when another one joins or leaves

  bool operator==(const ControllerState& other) const {
    return buttonFlags == other.buttonFlags && leftTrigger == other.leftTrigger &&
           rightTrigger == other.rightTrigger && leftStickX == other.leftStickX &&
           leftStickY == other.leftStickY && rightStickX == other.rightStickX &&
           rightStickY == other.rightStickY && activeMask == other.activeMask;
  }
};

class ControllerSendFilter {
 public:
  static constexpr int kSlots = 16;
  static constexpr int64_t kKeepAliveMs = 100;

  // Whether the state has to be sent now. A slot outside the range is always sent, so the caller never loses input.
  // Times are compared as the low 32 bits of the millisecond clock, which is exact for spans shorter than 24 days.
  bool ShouldSend(int slot, const ControllerState& state, int64_t nowMs) {
    if (slot < 0 || slot >= kSlots) {
      return true;
    }
    Slot& last = m_Slots[slot];
    const uint32_t now = static_cast<uint32_t>(nowMs);
    const bool due = !last.valid || !(last.state == state) ||
                     static_cast<int32_t>(now - last.sentAt) >= static_cast<int32_t>(kKeepAliveMs);
    if (due) {
      last.valid = true;
      last.state = state;
      last.sentAt = now;
    }
    return due;
  }

  // Forgets what was sent for one controller, so its next state goes out at once
  void Reset(int slot) {
    if (slot >= 0 && slot < kSlots) {
      m_Slots[slot].valid = false;
    }
  }

  void ResetAll() {
    for (Slot& slot : m_Slots) {
      slot.valid = false;
    }
  }

 private:
  struct Slot {
    bool valid = false;
    ControllerState state{};
    uint32_t sentAt = 0;
  };

  Slot m_Slots[kSlots];
};
