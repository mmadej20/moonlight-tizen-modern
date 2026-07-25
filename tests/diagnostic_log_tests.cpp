#include "../wasm/diagnostic_log.hpp"

#include <cassert>
#include <string>

int main() {
  {
    DiagnosticLogBuffer buffer(256);
    assert(buffer.TryAppend(10, "first"));
    assert(buffer.TryAppend(20, "second\n"));

    const std::string drained = buffer.Drain();
    assert(drained.find("[10 ms] first\n") != std::string::npos);
    assert(drained.find("[20 ms] second\n") != std::string::npos);
    assert(drained.find("first") < drained.find("second"));
    assert(buffer.Drain().empty());
  }

  {
    DiagnosticLogBuffer buffer(36);
    assert(buffer.TryAppend(1, "oldest-record"));
    assert(buffer.TryAppend(2, "newest-record"));

    const std::string drained = buffer.Drain();
    assert(drained.find("oldest-record") == std::string::npos);
    assert(drained.find("newest-record") != std::string::npos);
  }

  {
    DiagnosticLogBuffer buffer(96);
    assert(!buffer.TryAppend(30, std::string(200, 'x')));
    assert(buffer.TryAppend(40, "capture-resumed"));

    const std::string drained = buffer.Drain();
    assert(drained.find("dropped 1 diagnostic record") != std::string::npos);
    assert(drained.find("capture-resumed") != std::string::npos);
  }

  return 0;
}
