#include "wasm/video_timing.hpp"

#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>

using namespace std::chrono_literals;

static void AssertNear(double actual, double expected) {
  assert(std::fabs(actual - expected) < 0.000001);
}

int main() {
  VideoTimestampState state{};
  AssertNear(RebasePresentationTimestamp(1000, state), 0.0);
  AssertNear(RebasePresentationTimestamp(1016, state), 0.016);
  AssertNear(RebasePresentationTimestamp(1050, state), 0.050);
  AssertNear(RebasePresentationTimestamp(1049, state), 0.050);
  AssertNear(RebasePresentationTimestamp(1066, state), 0.066);

  VideoTimestampState wrapping{};
  AssertNear(RebasePresentationTimestamp(UINT32_MAX - 15, wrapping), 0.0);
  AssertNear(RebasePresentationTimestamp(16, wrapping), 0.032);

  VideoTimestampState committed{};
  AssertNear(RebasePresentationTimestamp(2000, committed), 0.0);
  auto candidate = committed;
  AssertNear(RebasePresentationTimestamp(2033, candidate), 0.033);
  AssertNear(RebasePresentationTimestamp(2016, committed), 0.016);

  auto noWait = CalculatePacingWait(-1us, 500us);
  assert(noWait.sleep == 0us && noWait.spin == 0us);

  auto spinOnly = CalculatePacingWait(300us, 500us);
  assert(spinOnly.sleep == 0us && spinOnly.spin == 300us);

  auto hybrid = CalculatePacingWait(2500us, 500us);
  assert(hybrid.sleep == 2000us && hybrid.spin == 500us);
}
