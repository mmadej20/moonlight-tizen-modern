#include "wasm/web_audio_decode.hpp"
#include <cassert>

int main() {
  const unsigned char mapping[] = {0, 1};
  int error = 0;
  auto* encoder = opus_multistream_encoder_create(48000, 2, 1, 1, mapping,
                                                  OPUS_APPLICATION_AUDIO, &error);
  assert(encoder && error == OPUS_OK);
  auto* decoder = opus_multistream_decoder_create(48000, 2, 1, 1, mapping, &error);
  assert(decoder && error == OPUS_OK);
  opus_int16 pcm[480 * 2] = {};
  opus_int16 output[480 * 2] = {};
  unsigned char packet[4096];
  int length = opus_multistream_encode(encoder, pcm, 240, packet, sizeof(packet));
  assert(length > 0);
  assert(DecodeWebAudioPacket(decoder, packet, length, output, 240, 480) == 240);
  // One missing 5 ms packet must produce 5 ms PLC, not an extra 5 ms of audio.
  assert(DecodeWebAudioPacket(decoder, nullptr, 0, output, 240, 480) == 240);
  assert(DecodeWebAudioPacket(decoder, nullptr, 0, output, 480, 480) == 480);
  // Actual packets may be longer than the nominal 5 ms and still fit the slot.
  length = opus_multistream_encode(encoder, pcm, 480, packet, sizeof(packet));
  assert(length > 0);
  assert(DecodeWebAudioPacket(decoder, packet, length, output, 240, 480) == 480);
  opus_multistream_decoder_destroy(decoder);
  opus_multistream_encoder_destroy(encoder);
}
