#include "wasm/request_registry.hpp"
#include "libgamestream/http.h"
#include "libgamestream/errors.h"
#include <openssl/ssl.h>
#include <curl/curl.h>
#include <cassert>
#include <chrono>
#include <string>
#include <thread>

// Plain loopback HTTP exercises the production bridge without a client TLS identity.
X509* g_Cert = nullptr;
EVP_PKEY* g_PrivateKey = nullptr;

int main(int argc, char** argv) {
  assert(argc == 3);
  const std::string mode(argv[2]);
  curl_global_init(CURL_GLOBAL_DEFAULT);
  HttpRequestRegistry registry;
  auto request = registry.Create(1, 3000, mode == "regular" ? 10000 : 0);
  PHTTP_DATA data = http_create_data(HTTP_TEXT_MAX_BYTES);
  assert(data);
  std::thread canceller;
  if (mode == "cancel") {
    canceller = std::thread([&] {
      std::this_thread::sleep_for(std::chrono::milliseconds(300));
      assert(registry.Cancel(1));
    });
  }
  const auto start = std::chrono::steady_clock::now();
  const int result = http_request(argv[1], nullptr, request.get(), data);
  const auto elapsed = std::chrono::steady_clock::now() - start;
  if (canceller.joinable()) canceller.join();
  if (mode == "pair") {
    assert(result == GS_OK);
    assert(std::string(data->memory, data->size) == "paired");
    assert(elapsed >= std::chrono::seconds(4));
  } else if (mode == "cancel") {
    assert(result == GS_CANCELLED);
    assert(elapsed < std::chrono::seconds(4));
  } else {
    assert(result == GS_TIMEOUT);
    assert(elapsed < std::chrono::seconds(4));
  }
  http_free_data(data);
  registry.Remove(1);
  assert(registry.Size() == 0);
  // Cancellation is isolated: a fresh request can complete immediately.
  if (mode == "cancel") {
    request = registry.Create(2, 3000, 0);
    data = http_create_data(HTTP_TEXT_MAX_BYTES);
    std::string url(argv[1]);
    url = url.substr(0, url.rfind('/')) + "/fast";
    assert(http_request(url.c_str(), nullptr, request.get(), data) == GS_OK);
    http_free_data(data);
    registry.Remove(2);
  }
  curl_global_cleanup();
}
