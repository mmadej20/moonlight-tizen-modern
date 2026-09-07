#pragma once

#include <opus_multistream.h>

inline int DecodeWebAudioPacket(OpusMSDecoder* decoder,
                                const unsigned char* packet, int length,
                                opus_int16* output, int negotiatedSamples,
                                int capacity) {
  // For PLC, Opus uses frame_size as the missing duration. Real packets may
  // use the whole slot, but a missing packet must match the negotiated size.
  const int frameSize = packet == nullptr || length == 0 ? negotiatedSamples : capacity;
  return opus_multistream_decode(decoder, packet, length, output, frameSize, 0);
}
