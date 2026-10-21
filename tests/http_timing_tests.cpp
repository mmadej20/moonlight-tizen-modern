#include "wasm/http_timing.hpp"

#include <cassert>
#include <string>

int main() {
  // curl reports cumulative times. The stages are told apart so that the log says where a slow request spent its time:
  // the name lookup, the TCP connection, the TLS handshake (done by this device in software), the wait for the host
  // to start answering, and the transfer of the answer.
  assert(DescribeHttpTiming(3, 15, 2665, 2785, 2793) ==
         "dns 3 ms, connect 12 ms, tls 2650 ms, host 120 ms, transfer 8 ms, total 2793 ms");

  // Plain HTTP has no handshake (curl reports 0 for it), and the part is left out.
  assert(DescribeHttpTiming(1, 5, 0, 25, 26) == "dns 1 ms, connect 4 ms, host 20 ms, transfer 1 ms, total 26 ms");

  // A request that failed before the host answered reports zeros for the stages it never reached.
  assert(DescribeHttpTiming(2, 3010, 0, 0, 3011) == "dns 2 ms, connect 3008 ms, host 0 ms, transfer 3011 ms, total 3011 ms");

  // Values that arrive in a surprising order never produce a negative stage.
  assert(DescribeHttpTiming(10, 5, 4, 3, 2) == "dns 10 ms, connect 0 ms, tls 0 ms, host 0 ms, transfer 0 ms, total 2 ms");

  // Polling requests keep 3 s to connect; a request that the user waits for (10 s in total) gets 8 s, so that a slow
  // name lookup and handshake on a busy TV do not end the start of a stream.
  assert(HttpConnectTimeoutMs(0) == 3000);
  assert(HttpConnectTimeoutMs(5000) == 3000);
  assert(HttpConnectTimeoutMs(9999) == 3000);
  assert(HttpConnectTimeoutMs(10000) == 8000);
  assert(HttpConnectTimeoutMs(30000) == 8000);

  // Only requests that took a second or more are worth a line.
  assert(!ShouldLogHttpTiming(0));
  assert(!ShouldLogHttpTiming(999));
  assert(ShouldLogHttpTiming(1000));
  assert(ShouldLogHttpTiming(60000));

  return 0;
}
