#include <cassert>
#include <cmath>

#include "wasm/audio_sync.hpp"

namespace {

void AssertNear(double actual, double expected) {
  assert(std::abs(actual - expected) < 0.000001);
}

void TestAcceptedPacketAdvancesEstimatedEnd() {
  AudioSyncController controller(0.200, 0.120, 0.350, 10);

  assert(controller.ObservePacket(0.000) == AudioSyncDecision::Append);
  controller.CommitAppend(0.000, 0.005);

  AssertNear(controller.EstimatedLead(0.000), 0.005);
}

void TestObservationDoesNotAdvanceEstimatedEnd() {
  AudioSyncController controller(0.200, 0.120, 0.350, 10);

  for (int i = 0; i < 20; ++i) {
    assert(controller.ObservePacket(0.000) == AudioSyncDecision::Append);
  }

  AssertNear(controller.EstimatedLead(0.000), 0.000);
}

void TestSoftCorrectionDropsAtMostOnePacketInTen() {
  AudioSyncController controller(0.200, 0.120, 0.350, 10);
  controller.CommitAppend(0.000, 0.205);

  for (int i = 0; i < 9; ++i) {
    assert(controller.ObservePacket(0.000) == AudioSyncDecision::Append);
  }
  assert(controller.ObservePacket(0.000) == AudioSyncDecision::DropSoft);

  for (int i = 0; i < 9; ++i) {
    assert(controller.ObservePacket(0.000) == AudioSyncDecision::Append);
  }
  assert(controller.ObservePacket(0.000) == AudioSyncDecision::DropSoft);
}

void TestHardLimitDropsConsecutively() {
  AudioSyncController controller(0.200, 0.120, 0.350, 10);
  controller.CommitAppend(0.000, 0.355);

  assert(controller.ObservePacket(0.000) == AudioSyncDecision::DropHard);
  assert(controller.ObservePacket(0.000) == AudioSyncDecision::DropHard);
}

void TestSoftCorrectionUsesLowWatermarkToClear() {
  AudioSyncController controller(0.200, 0.120, 0.350, 10);
  controller.CommitAppend(0.000, 0.205);

  for (int i = 0; i < 10; ++i) {
    controller.ObservePacket(0.000);
  }

  assert(controller.ObservePacket(0.090) == AudioSyncDecision::Append);
  for (int i = 0; i < 20; ++i) {
    assert(controller.ObservePacket(0.010) == AudioSyncDecision::Append);
  }
}

}  // namespace

int main() {
  TestAcceptedPacketAdvancesEstimatedEnd();
  TestObservationDoesNotAdvanceEstimatedEnd();
  TestSoftCorrectionDropsAtMostOnePacketInTen();
  TestHardLimitDropsConsecutively();
  TestSoftCorrectionUsesLowWatermarkToClear();
  return 0;
}
