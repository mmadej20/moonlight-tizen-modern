#include "moonlight-common-c/src/RtpVideoQueuePolicy.h"

#include <cassert>

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
  return 0;
}
