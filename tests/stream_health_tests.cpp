#include "wasm/stream_health.hpp"

#include <cassert>
#include <string>

namespace {

constexpr std::size_t MB = 1u << 20;

bool Contains(const std::string& text, const std::string& part) {
  return text.find(part) != std::string::npos;
}

}  // namespace

int main() {
  StreamHealth health;

  // Before any media arrives, ages are reported as -1 so a stalled start is distinguishable from a stall mid-stream.
  health.Reset(1000);
  assert(health.Snapshot(1500, 64 * MB, 128 * MB) ==
         "video=0/-1ms audio=0/-1ms"
         " videoAppendCalls=0 videoAppendMaxMs=0 videoAppendBlockedMs=0"
         " audioAppendCalls=0 audioAppendMaxMs=0 audioAppendBlockedMs=0"
         " inputPolls=0 inputPollMaxMs=0 inputPollBlockedMs=0"
         " mainCalls=0 mainCallMaxMs=0 mainCallBlockedMs=0 heap=64MB/128MB");

  // Ages are measured from the last submitted packet, counts keep growing.
  health.VideoSubmitted(2000);
  health.VideoSubmitted(2016);
  health.AudioSubmitted(2005);
  const std::string packets = health.Snapshot(2100, 70 * MB, 128 * MB);
  assert(Contains(packets, "video=2/84ms audio=1/95ms"));
  assert(Contains(packets, "heap=70MB/128MB"));

  // A section that is entered and not left shows how long its thread has been stuck. This is what tells a
  // wedged platform call (an append that never returns) from a stalled main thread (a poll that never returns).
  health.VideoAppend().Begin(3000);
  assert(Contains(health.Snapshot(3400, 0, 0), "videoAppendBlockedMs=400"));
  assert(Contains(health.Snapshot(3400, 0, 0), "audioAppendBlockedMs=0"));
  health.VideoAppend().End(3000, 3450);
  const std::string afterAppend = health.Snapshot(3500, 0, 0);
  assert(Contains(afterAppend, "videoAppendCalls=1 videoAppendMaxMs=450 videoAppendBlockedMs=0"));

  // The per-window maximum is reset by each snapshot, the call counter is cumulative.
  const std::string nextWindow = health.Snapshot(4500, 0, 0);
  assert(Contains(nextWindow, "videoAppendCalls=1 videoAppendMaxMs=0"));

  // Sections are independent of each other.
  health.InputPoll().Begin(5000);
  health.InputPoll().End(5000, 5003);
  health.AudioAppend().Begin(5100);
  health.AudioAppend().End(5100, 5101);
  health.MainCall().Begin(5200);
  health.MainCall().End(5200, 5260);
  const std::string independent = health.Snapshot(5300, 0, 0);
  assert(Contains(independent, "audioAppendCalls=1 audioAppendMaxMs=1"));
  assert(Contains(independent, "inputPolls=1 inputPollMaxMs=3"));
  assert(Contains(independent, "mainCalls=1 mainCallMaxMs=60"));

  // Several threads can wait at once: the blocked time counts from the first one that started waiting.
  health.MainCall().Begin(6000);
  health.MainCall().Begin(6200);
  assert(Contains(health.Snapshot(6300, 0, 0), "mainCallBlockedMs=300"));
  health.MainCall().End(6000, 6300);
  assert(Contains(health.Snapshot(6400, 0, 0), "mainCallBlockedMs=400"));
  health.MainCall().End(6200, 6450);
  assert(Contains(health.Snapshot(6500, 0, 0), "mainCallBlockedMs=0"));

  // The scope guard enters and leaves a section around a block of code.
  health.Reset(7000);
  {
    ScopedSection scope(health.InputPoll(), 7100);
    assert(Contains(health.Snapshot(7150, 0, 0), "inputPollBlockedMs=50"));
    scope.Finish(7160);
  }
  assert(Contains(health.Snapshot(7200, 0, 0), "inputPolls=1 inputPollMaxMs=60 inputPollBlockedMs=0"));

  // A new stream starts from zero.
  health.Reset(9000);
  assert(health.Snapshot(9100, 1 * MB, 2 * MB) ==
         "video=0/-1ms audio=0/-1ms"
         " videoAppendCalls=0 videoAppendMaxMs=0 videoAppendBlockedMs=0"
         " audioAppendCalls=0 audioAppendMaxMs=0 audioAppendBlockedMs=0"
         " inputPolls=0 inputPollMaxMs=0 inputPollBlockedMs=0"
         " mainCalls=0 mainCallMaxMs=0 mainCallBlockedMs=0 heap=1MB/2MB");

  // Times are kept as the low 32 bits of the clock (the Samsung toolchain has no working 64-bit compare-exchange),
  // so ages must stay right across the wrap of the 32-bit counter.
  health.Reset(4294967000LL);
  health.VideoSubmitted(4294967290LL);
  assert(Contains(health.Snapshot(4294967290LL + 100, 0, 0), "video=1/100ms"));
  assert(Contains(health.Snapshot(4294967296LL + 10, 0, 0), "video=1/16ms"));
  health.MainCall().Begin(4294967290LL);
  assert(Contains(health.Snapshot(4294967296LL + 10, 0, 0), "mainCallBlockedMs=16"));
  health.MainCall().End(4294967290LL, 4294967296LL + 20);
  assert(Contains(health.Snapshot(4294967296LL + 30, 0, 0), "mainCalls=1 mainCallMaxMs=26 mainCallBlockedMs=0"));

  // A new stream may start while a thread is still inside a section; leaving it afterwards must not corrupt the counters.
  health.Reset(10000);
  health.MainCall().Begin(10000);
  health.Reset(10010);
  health.MainCall().End(10000, 10020);
  assert(Contains(health.Snapshot(10100, 0, 0), "mainCalls=1 mainCallMaxMs=20 mainCallBlockedMs=0"));
  health.MainCall().Begin(10200);
  assert(Contains(health.Snapshot(10300, 0, 0), "mainCallBlockedMs=100"));
  health.MainCall().End(10200, 10300);
  assert(Contains(health.Snapshot(10400, 0, 0), "mainCallBlockedMs=0"));

  return 0;
}
