#include "wasm/udp_recv_probe.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>

using namespace udpprobe;

// A receive that does what it should: writes the datagram, but no more than it was asked for
static int HonestReceive(uint8_t* buffer, int length, int datagram) {
  const int count = datagram < length ? datagram : length;
  for (int i = 0; i < count; ++i) buffer[i] = PayloadByte(static_cast<size_t>(i));
  return count;
}

static int FreePort() {
  const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = 0;
  assert(::bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == 0);
  socklen_t l = sizeof(a);
  assert(::getsockname(fd, reinterpret_cast<sockaddr*>(&a), &l) == 0);
  const int port = ntohs(a.sin_port);
  ::close(fd);
  return port;
}

static void SendDatagram(int port, int size) {
  const int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  a.sin_port = htons(static_cast<uint16_t>(port));
  uint8_t data[2048];
  for (int i = 0; i < size; ++i) data[i] = PayloadByte(static_cast<size_t>(i));
  assert(::sendto(fd, data, static_cast<size_t>(size), 0, reinterpret_cast<sockaddr*>(&a), sizeof(a)) == size);
  ::close(fd);
}

int main() {
  // A receive that stays inside the buffer is reported as fine, whether the datagram is shorter or longer
  {
    Result r = Receive(64, [](uint8_t* b, int n) { return HonestReceive(b, n, 40); });
    assert(r.received == 40 && r.overrunBytes == 0 && r.underrunBytes == 0 && r.payloadMismatch == -1);
    r = Receive(64, [](uint8_t* b, int n) { return HonestReceive(b, n, 300); });
    assert(r.received == 64 && r.overrunBytes == 0 && r.underrunBytes == 0 && r.payloadMismatch == -1);
    char line[400];
    Describe(r, false, line, sizeof(line));
    assert(std::strstr(line, "verdict=OK") != nullptr);
  }

  // A receive that writes the whole datagram of 300 bytes into a buffer of 64 is caught, with the extent of the damage
  {
    Result r = Receive(64, [](uint8_t* b, int) { for (int i = 0; i < 300; ++i) b[i] = PayloadByte(static_cast<size_t>(i)); return 300; });
    assert(r.received == 300);
    assert(r.overrunBytes == 236);  // 300 - 64 bytes of the 256 guard bytes, none of them hidden by a lucky value
    assert(r.firstOverrun == 0);
    assert(r.lastOverrun == 235);
    assert(r.underrunBytes == 0);
    char line[400];
    Describe(r, true, line, sizeof(line));
    assert(std::strstr(line, "verdict=WRITES_OUTSIDE_THE_BUFFER") != nullptr);
    assert(std::strstr(line, "addressArgs=1") != nullptr);
  }

  // Bytes written before the buffer count too
  {
    Result r = Receive(32, [](uint8_t* b, int n) { std::memset(b - 8, 0x11, 8); return HonestReceive(b, n, 10); });
    assert(r.underrunBytes == 8 && r.overrunBytes == 0);
  }

  // A payload that is not what the sender sends is noticed at its first byte
  {
    Result r = Receive(32, [](uint8_t* b, int n) { int c = HonestReceive(b, n, 20); b[5] ^= 0xFF; return c; });
    assert(r.payloadMismatch == 5);
  }

  // A failed receive is not an overrun
  {
    Result r = Receive(32, [](uint8_t*, int) { errno = EAGAIN; return -1; });
    assert(r.received == -1 && r.error == EAGAIN && r.overrunBytes == 0);
    char line[400];
    Describe(r, false, line, sizeof(line));
    assert(std::strstr(line, "verdict=NOTHING_RECEIVED") != nullptr);
  }

  // Real sockets on the host: Linux cuts a datagram that is longer than the buffer, with and without a source address
  for (int withAddress = 0; withAddress < 2; ++withAddress) {
    const int port = FreePort();
    std::thread sender([port] {
      std::this_thread::sleep_for(std::chrono::milliseconds(150));
      SendDatagram(port, 300);
    });
    const Result r = ReceiveOnSocket(port, 64, 3000, withAddress != 0);
    sender.join();
    assert(r.received == 64);
    assert(r.overrunBytes == 0 && r.underrunBytes == 0 && r.payloadMismatch == -1);
  }

  // Nothing arrives: the receive times out and says so
  {
    const int port = FreePort();
    const Result r = ReceiveOnSocket(port, 64, 200, false);
    assert(r.received == -1);
  }

  std::puts("udp recv probe tests passed");
  return 0;
}
