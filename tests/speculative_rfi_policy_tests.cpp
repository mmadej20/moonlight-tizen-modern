#include "moonlight-common-c/src/RtpVideoQueuePolicy.h"
#include "moonlight-common-c/src/Limelight.h"
#include "wasm/rfi_capabilities.hpp"

#include <cassert>
#include <iostream>

int main() {
  // Tizen's current decoder does not advertise RFI, so a late packet must not
  // cause speculative reference-state invalidation.
  assert(!shouldUseSpeculativeRfi(false, false, false, 3, 2));

  // Preserve the existing optimization for renderers that can actually use RFI.
  assert(shouldUseSpeculativeRfi(false, false, true, 3, 2));

  assert(!shouldUseSpeculativeRfi(true, false, true, 3, 2));
  assert(!shouldUseSpeculativeRfi(false, true, true, 3, 2));
  assert(!shouldUseSpeculativeRfi(false, false, true, 2, 2));
  assert(!shouldUseSpeculativeRfi(false, false, true, 1, 2));

  const int baseCapabilities = CAPABILITY_SLICES_PER_FRAME(4);

  assert(decoderCapabilitiesWithOptionalRfi(
      baseCapabilities, false, VIDEO_FORMAT_H264) == baseCapabilities);
  assert(decoderCapabilitiesWithOptionalRfi(
      baseCapabilities, true, 0) == baseCapabilities);

  assert(decoderCapabilitiesWithOptionalRfi(
      baseCapabilities, true, VIDEO_FORMAT_H264) ==
      (baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AVC));

  assert(decoderCapabilitiesWithOptionalRfi(
      baseCapabilities, true, VIDEO_FORMAT_H265) ==
      (baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC));
  assert(decoderCapabilitiesWithOptionalRfi(
      baseCapabilities, true, VIDEO_FORMAT_H265_MAIN10) ==
      (baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC));

  assert(decoderCapabilitiesWithOptionalRfi(
      baseCapabilities, true, VIDEO_FORMAT_AV1_MAIN8) ==
      (baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1));
  assert(decoderCapabilitiesWithOptionalRfi(
      baseCapabilities, true, VIDEO_FORMAT_AV1_MAIN10) ==
      (baseCapabilities | CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1));

  std::cout << "speculative_rfi_policy_tests: PASS\n";
  return 0;
}
