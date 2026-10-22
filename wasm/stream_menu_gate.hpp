#pragma once

#include <atomic>
#include <cstdint>

// The stream menu is opened from the controller by holding Select for a second. While it is open the controllers, the keyboard
// and the mouse belong to the menu: nothing of them goes to the host. This class is the part of that which has no platform
// in it. The polling thread of the controllers asks it two things, whether Select has been held long enough (UpdateHold)
// and what to do with the state of a controller (Decide); the page tells it that the menu is open or closed (SetCaptured).

class StreamMenuGate {
 public:
  static constexpr int kMaxSlots = 16;
  static constexpr int64_t kHoldMs = 1000;
  static constexpr uint16_t kSelectFlag = 0x0020;  // BACK_FLAG of Limelight.h (gamepad.cpp asserts that it is the same)

  enum class SendDecision {
    Send,         // the state goes to the host as it is
    SendNeutral,  // one state with no button and no stick goes to the host: the menu opened and the host must not be left pressed
    Skip,         // nothing goes to the host
  };

  // Whether Select, held alone, has been down long enough to open the menu. It is true once per hold, and it also takes the
  // input (the page is told by the message that the native side posts, and confirms it with SetCaptured). A Select that is
  // still down when the menu closes has to be released before it can open the menu again.
  bool UpdateHold(int slot, int64_t nowMs, uint16_t buttonFlags) {
    if (!InRange(slot)) {
      return false;
    }
    Hold& hold = m_Holds[slot];
    if ((buttonFlags & kSelectFlag) == 0) {
      hold.armed = true;
      hold.since = kNone;
      return false;
    }
    if (m_Captured.load()) {
      hold.armed = false;
      hold.since = kNone;
      return false;
    }
    // Select with other buttons is a combo of its own (stop the stream, the statistics), not a hold
    if (!hold.armed || buttonFlags != kSelectFlag) {
      hold.since = kNone;
      return false;
    }
    if (hold.since == kNone) {
      hold.since = nowMs;
      return false;
    }
    if (nowMs - hold.since >= kHoldMs) {
      hold.since = kNone;
      hold.armed = false;
      m_Captured.store(true);
      return true;
    }
    return false;
  }

  // Called from the thread of the page; the polling thread reads it
  void SetCaptured(bool captured) { m_Captured.store(captured); }
  bool IsCaptured() const { return m_Captured.load(); }

  // What to do with the state of one controller. While the menu is open the host gets one neutral state and then nothing. After
  // it nothing goes either, until the controller had no button down once: the button that closed the menu is still down, and
  // the game must not see its press. A slot outside the range is always sent, so that the caller never loses input.
  SendDecision Decide(int slot, uint16_t buttonFlags) {
    if (!InRange(slot)) {
      return SendDecision::Send;
    }
    Phase& phase = m_Phases[slot];
    const bool captured = m_Captured.load();
    switch (phase) {
      case Phase::Normal:
        if (captured) {
          phase = Phase::Captured;
          return SendDecision::SendNeutral;
        }
        return SendDecision::Send;
      case Phase::Captured:
        if (captured) {
          return SendDecision::Skip;
        }
        if (buttonFlags == 0) {
          phase = Phase::Normal;
          return SendDecision::Send;
        }
        phase = Phase::WaitingRelease;
        return SendDecision::Skip;
      case Phase::WaitingRelease:
        if (captured) {
          phase = Phase::Captured;
          return SendDecision::Skip;
        }
        if (buttonFlags == 0) {
          phase = Phase::Normal;
          return SendDecision::Send;
        }
        return SendDecision::Skip;
    }
    return SendDecision::Send;
  }

 private:
  static constexpr int64_t kNone = -1;

  enum class Phase { Normal, Captured, WaitingRelease };

  struct Hold {
    bool armed = true;
    int64_t since = kNone;
  };

  static bool InRange(int slot) { return slot >= 0 && slot < kMaxSlots; }

  std::atomic<bool> m_Captured{false};
  Hold m_Holds[kMaxSlots];
  Phase m_Phases[kMaxSlots] = {};
};

// One gate for the stream: the polling thread of the controllers and the handlers of the keyboard and the mouse share it
inline StreamMenuGate& MenuGate() {
  static StreamMenuGate gate;
  return gate;
}
