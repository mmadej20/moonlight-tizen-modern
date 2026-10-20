// Compiled only by a diagnostic build (docker build --build-arg ALLOC_STRESS=ON); see udp_recv_probe.hpp for what it
// checks. Driven from the inspector of a debuggable application, by tools/tv-debug/udp_probe_run.js:
//   Module.udpProbeStart(port, bufferLength, timeoutMs, withAddress)   one receive, on a worker thread
//   Module.udpProbeReportPointer()                                     address of a text line, read it from HEAPU8
#ifdef MOONLIGHT_ALLOC_STRESS

#include <emscripten/bind.h>

#include <atomic>
#include <cstdint>
#include <thread>

#include "udp_recv_probe.hpp"

namespace {

std::atomic<int> g_State{0};  // 0 idle, 1 running, 2 done
std::thread g_Thread;
char g_Report[512] = "state=idle";

int StartUdpProbe(int port, int bufferLength, int timeoutMs, int withAddress) {
  if (g_State.load() == 1) return 0;
  if (g_Thread.joinable()) g_Thread.join();
  if (bufferLength < 1 || bufferLength > 65000) return 0;
  g_State.store(1);
  std::snprintf(g_Report, sizeof(g_Report), "state=running port=%d bufferLength=%d", port, bufferLength);
  g_Thread = std::thread([port, bufferLength, timeoutMs, withAddress] {
    const udpprobe::Result result = udpprobe::ReceiveOnSocket(port, bufferLength, timeoutMs, withAddress != 0);
    char line[sizeof(g_Report)];
    udpprobe::Describe(result, withAddress != 0, line, sizeof(line));
    std::snprintf(g_Report, sizeof(g_Report), "%s", line);
    g_State.store(2);
  });
  return 1;
}

// A pointer instead of a string: reading the report must not allocate
int UdpProbeReportPointer() {
  return static_cast<int>(reinterpret_cast<uintptr_t>(g_Report));
}

}  // namespace

EMSCRIPTEN_BINDINGS(udp_recv_probe) {
  emscripten::function("udpProbeStart", &StartUdpProbe);
  emscripten::function("udpProbeReportPointer", &UdpProbeReportPointer);
}

#endif
