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

// Only requests that took a second or more are worth a line
inline bool ShouldLogHttpTiming(long totalMs) {
  return totalMs >= 1000;
}
