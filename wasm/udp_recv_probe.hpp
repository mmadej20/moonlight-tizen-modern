#ifndef MOONLIGHT_WASM_UDP_RECV_PROBE_HPP
#define MOONLIGHT_WASM_UDP_RECV_PROBE_HPP

// Does the UDP receive of the TV (the native host binding tizentvwasm.SocketsHostBindings.recvFrom, whose source is not
// available) write only as many bytes as it was asked for? A heap chunk found in a frozen stream held a whole video
// packet in a chunk that is smaller than the packet buffer (docs/2026-10-18-stream-hang-investigation.md, section 12).
//
// The probe receives one datagram the way the video thread does, recvfrom(s, buffer, size, 0, NULL, NULL), into a buffer
// that has a pattern before and after it, and reports how many bytes of the pattern were overwritten, and where. A
// sender that sends datagrams longer than the buffer then shows whether the platform truncates them. The receive
// function is injectable so that the detection can be tested on the host with a receive that overruns on purpose.

#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <functional>
#include <vector>

#ifndef _WIN32
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#endif

namespace udpprobe {

constexpr int kGuardBytes = 256;
constexpr uint8_t kGuardPattern = 0xA5;

// What the sender puts in its datagrams, so that the received bytes can be checked. It never equals the pattern of the
// guard bytes, so that no overrun byte can pass for an untouched one.
inline uint8_t PayloadByte(size_t index) {
  const uint8_t value = static_cast<uint8_t>(index * 7 + 3);
  return value == kGuardPattern ? static_cast<uint8_t>(kGuardPattern + 1) : value;
}

struct Result {
  int received = -2;        // return value of the receive, -2 when it never ran
  int error = 0;            // errno when the receive failed
  int bufferLength = 0;
  int overrunBytes = 0;     // guard bytes after the buffer that no longer hold the pattern
  int firstOverrun = -1;    // offset after the end of the buffer of the first changed byte
  int lastOverrun = -1;
  int underrunBytes = 0;    // guard bytes before the buffer that changed
  int payloadMismatch = -1; // offset of the first received byte that is not what the sender sends, -1 if none
};

// receive(buffer, length) -> bytes, or -1 with errno set
using ReceiveFunction = std::function<int(uint8_t*, int)>;

inline Result Receive(int bufferLength, const ReceiveFunction& receive) {
  Result r;
  r.bufferLength = bufferLength;
  std::vector<uint8_t> memory(static_cast<size_t>(bufferLength) + 2 * kGuardBytes, kGuardPattern);
  uint8_t* buffer = memory.data() + kGuardBytes;
  // The buffer itself starts as something else than the pattern, so that "not written" is visible too
  std::memset(buffer, 0x00, static_cast<size_t>(bufferLength));

  r.received = receive(buffer, bufferLength);
  if (r.received < 0) r.error = errno;

  for (int i = 0; i < kGuardBytes; ++i) {
    if (memory[static_cast<size_t>(i)] != kGuardPattern) r.underrunBytes++;
    const uint8_t after = memory[static_cast<size_t>(kGuardBytes + bufferLength + i)];
    if (after != kGuardPattern) {
      r.overrunBytes++;
      if (r.firstOverrun < 0) r.firstOverrun = i;
      r.lastOverrun = i;
    }
  }
  const int checked = r.received < bufferLength ? r.received : bufferLength;
  for (int i = 0; i < checked; ++i) {
    if (buffer[i] != PayloadByte(static_cast<size_t>(i))) { r.payloadMismatch = i; break; }
  }
  return r;
}

inline size_t Describe(const Result& r, bool withAddress, char* out, size_t capacity) {
  const int written = std::snprintf(
      out, capacity,
      "state=done addressArgs=%d bufferLength=%d received=%d errno=%d overrunBytes=%d firstOverrun=%d lastOverrun=%d "
      "underrunBytes=%d payloadMismatch=%d verdict=%s",
      withAddress ? 1 : 0, r.bufferLength, r.received, r.error, r.overrunBytes, r.firstOverrun, r.lastOverrun,
      r.underrunBytes, r.payloadMismatch,
      r.received < 0 ? "NOTHING_RECEIVED" : (r.overrunBytes > 0 || r.underrunBytes > 0 ? "WRITES_OUTSIDE_THE_BUFFER" : "OK"));
  return written < 0 ? 0 : static_cast<size_t>(written);
}

#ifndef _WIN32
// The receive of the video thread on a bound UDP socket (recvfrom with NULL source arguments), or with a source address
// when withAddress is set. The socket is bound to the port, waits up to timeoutMs for one datagram.
inline Result ReceiveOnSocket(int port, int bufferLength, int timeoutMs, bool withAddress) {
  const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  Result failed;
  failed.bufferLength = bufferLength;
  if (fd < 0) { failed.error = errno; return failed; }
  sockaddr_in local{};
  local.sin_family = AF_INET;
  local.sin_addr.s_addr = htonl(INADDR_ANY);
  local.sin_port = htons(static_cast<uint16_t>(port));
  if (::bind(fd, reinterpret_cast<sockaddr*>(&local), sizeof(local)) < 0) {
    failed.error = errno;
    ::close(fd);
    return failed;
  }
  timeval timeout{};
  timeout.tv_sec = timeoutMs / 1000;
  timeout.tv_usec = (timeoutMs % 1000) * 1000;
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));

  Result result = Receive(bufferLength, [&](uint8_t* buffer, int length) -> int {
    if (withAddress) {
      sockaddr_in from{};
      socklen_t fromLength = sizeof(from);
      return static_cast<int>(::recvfrom(fd, buffer, static_cast<size_t>(length), 0, reinterpret_cast<sockaddr*>(&from), &fromLength));
    }
    return static_cast<int>(::recvfrom(fd, buffer, static_cast<size_t>(length), 0, nullptr, nullptr));
  });
  ::close(fd);
  return result;
}
#endif

}  // namespace udpprobe

#endif
