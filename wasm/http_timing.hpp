#pragma once

#include <algorithm>
#include <string>

// The time of a slow request is split into the stages that curl reports, so that the log tells a slow TLS handshake
// (done by this device in software) from a host that is slow to answer or a connection that never opened.
// curl gives cumulative times in milliseconds: name lookup, connected, TLS done (0 for plain HTTP), first byte, total.
inline std::string DescribeHttpTiming(long namelookupMs, long connectMs, long appconnectMs,
                                       long starttransferMs, long totalMs) {
  const long dns = std::max(0L, namelookupMs);
  const long connect = std::max(0L, connectMs - namelookupMs);
  const bool hasTls = appconnectMs > 0;
  const long tls = hasTls ? std::max(0L, appconnectMs - connectMs) : 0L;
  const long afterHandshake = hasTls ? appconnectMs : connectMs;
  const long host = starttransferMs > 0 ? std::max(0L, starttransferMs - afterHandshake) : 0L;
  const long transfer = std::max(0L, totalMs - (starttransferMs > 0 ? starttransferMs : 0L));

  std::string text = "dns " + std::to_string(dns) + " ms, connect " + std::to_string(connect) + " ms";
  if (hasTls) {
    text += ", tls " + std::to_string(tls) + " ms";
  }
  text += ", host " + std::to_string(host) + " ms, transfer " + std::to_string(transfer) +
          " ms, total " + std::to_string(std::max(0L, totalMs)) + " ms";
  return text;
}

// The time that a request may spend before the connection is made: name lookup, TCP connect and the TLS handshake, which
// this device does in software. A request that the user waits for (launch, resume and quit have 10 s in total) gets
// more: on a busy TV, right after the app was installed, the lookup of an address took 2.6 s and the handshake up to
// 2.6 s, and a limit of 3 s ended the start of a stream. The requests that poll the host keep 3 s.
inline long HttpConnectTimeoutMs(long totalTimeoutMs) {
  return totalTimeoutMs >= 10000 ? 8000 : 3000;
}

// Only requests that took a second or more are worth a line
inline bool ShouldLogHttpTiming(long totalMs) {
  return totalMs >= 1000;
}
