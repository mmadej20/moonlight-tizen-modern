// The allocator stress test is compiled into the module only by a diagnostic build
// (docker build --build-arg ALLOC_STRESS=ON). It is driven from the inspector of a debuggable application:
//   Module.allocStressStart(threads, seconds, modes, liveBlocks, pauseEvery, pauseMicros)
//                                                                  modes: 1 mutex, 2 atomic, 4 spin, 8 malloc, 16 handoff
//   Module.allocStressReportPointer()                              address of a text line, read it from HEAPU8
//   Module.allocStressStop()
#ifdef MOONLIGHT_ALLOC_STRESS

#include <emscripten/bind.h>

#include <cstdint>

#include "alloc_stress.hpp"

namespace {

allocstress::Runner g_Runner;
char g_ReportBuffer[768];

int StartAllocStress(int threads, int seconds, int modes, int liveBlocks, int pauseEvery, int pauseMicros) {
  allocstress::Config config;
  config.threads = threads;
  config.seconds = seconds;
  config.modes = static_cast<uint32_t>(modes);
  config.liveBlocks = liveBlocks;
  config.pauseEvery = pauseEvery;
  config.pauseMicros = pauseMicros;
  return g_Runner.Start(config) ? 1 : 0;
}

void StopAllocStress() {
  g_Runner.RequestStop();
}

// A pointer instead of a string: reading the report must not allocate, because a hang in the allocator is what is
// being looked for
int AllocStressReportPointer() {
  g_Runner.Describe(g_ReportBuffer, sizeof(g_ReportBuffer));
  return static_cast<int>(reinterpret_cast<uintptr_t>(g_ReportBuffer));
}

}  // namespace

EMSCRIPTEN_BINDINGS(alloc_stress) {
  emscripten::function("allocStressStart", &StartAllocStress);
  emscripten::function("allocStressStop", &StopAllocStress);
  emscripten::function("allocStressReportPointer", &AllocStressReportPointer);
}

#endif
