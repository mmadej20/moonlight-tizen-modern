#pragma once

#include "../moonlight-common-c/src/Limelight.h"

inline int decoderCapabilitiesWithOptionalRfi(
    int baseCapabilities,
    bool enabled,
    int supportedVideoFormats) {
  if (!enabled) {
    return baseCapabilities;
  }

  if (supportedVideoFormats & VIDEO_FORMAT_MASK_H264) {
    return baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AVC;
  }

  if (supportedVideoFormats & VIDEO_FORMAT_MASK_H265) {
    return baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC;
  }

  if (supportedVideoFormats & VIDEO_FORMAT_MASK_AV1) {
    return baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1;
  }

  return baseCapabilities;
}
