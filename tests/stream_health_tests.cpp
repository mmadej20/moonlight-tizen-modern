#include "wasm/stream_health.hpp"

#include <cassert>
#include <string>

int main() {
  StreamHealth health;

  // Before any media arrives, ages are reported as -1 so a stalled start is distinguishable from a stall mid-stream.
  health.Reset(1000);
  assert(health.Snapshot(1500, 64u << 20, 128u << 20) ==
         "video=0/-1ms audio=0/-1ms mainCalls=0 mainCallMaxMs=0 mainCallBlockedMs=0 heap=64MB/128MB");

  // Ages are measured from the last submitted packet, counts keep growing.
  health.VideoSubmitted(2000);
  health.VideoSubmitted(2016);
  health.AudioSubmitted(2005);
  assert(health.Snapshot(2100, 70u << 20, 128u << 20) ==
         "video=2/84ms audio=1/95ms mainCalls=0 mainCallMaxMs=0 mainCallBlockedMs=0 heap=70MB/128MB");

  // A worker thread that waits for the main thread is visible while the call is in flight.
  health.MainCallBegin(3000);
  assert(health.Snapshot(3400, 70u << 20, 128u << 20).find("mainCallBlockedMs=400") != std::string::npos);
  health.MainCallEnd(3000, 3450);
  std::string afterCall = health.Snapshot(3500, 70u << 20, 128u << 20);
  assert(afterCall.find("mainCalls=1") != std::string::npos);
  assert(afterCall.find("mainCallMaxMs=450") != std::string::npos);
  assert(afterCall.find("mainCallBlockedMs=0") != std::string::npos);

  // The per-window maximum is reset by each snapshot, the call counter is cumulative.
  std::string nextWindow = health.Snapshot(4500, 70u << 20, 128u << 20);
  assert(nextWindow.find("mainCallMaxMs=0") != std::string::npos);
  assert(nextWindow.find("mainCalls=1") != std::string::npos);

  // Several threads can wait at once: the blocked time counts from the first one that started waiting.
  health.MainCallBegin(5000);
  health.MainCallBegin(5200);
  assert(health.Snapshot(5300, 0, 0).find("mainCallBlockedMs=300") != std::string::npos);
  health.MainCallEnd(5000, 5300);
  assert(health.Snapshot(5400, 0, 0).find("mainCallBlockedMs=400") != std::string::npos);
  health.MainCallEnd(5200, 5450);
  assert(health.Snapshot(5500, 0, 0).find("mainCallBlockedMs=0") != std::string::npos);

  // A new stream starts from zero.
  health.Reset(9000);
  assert(health.Snapshot(9100, 1u << 20, 2u << 20) ==
         "video=0/-1ms audio=0/-1ms mainCalls=0 mainCallMaxMs=0 mainCallBlockedMs=0 heap=1MB/2MB");

  return 0;
}
