extern "C" {
#include "moonlight-common-c/src/FecStatusTally.h"
}

#include <cassert>
#include <cstdint>

int main() {
  // A block is rebuilt when the packets that arrived, data and parity together, are at least its data packets
  assert(fecStatusBlockRecovered(10, 10, 0));
  assert(fecStatusBlockRecovered(10, 8, 2));
  assert(fecStatusBlockRecovered(10, 7, 4));
  assert(!fecStatusBlockRecovered(10, 8, 1));
  assert(!fecStatusBlockRecovered(10, 0, 0));
  // The sum does not wrap at 16 bits
  assert(fecStatusBlockRecovered(65535, 65535, 65535));

  FEC_STATUS_TALLY tally = {};
  uint32_t recovered = 99, unrecoverable = 99;

  // The first call starts the interval and gives nothing
  assert(!fecStatusTallyTake(&tally, 5000, &recovered, &unrecoverable));
  fecStatusTallyAdd(&tally, true);
  fecStatusTallyAdd(&tally, true);
  fecStatusTallyAdd(&tally, false);

  // Nothing before the interval is over, and the outputs stay untouched
  assert(!fecStatusTallyTake(&tally, 5000 + FEC_STATUS_TALLY_INTERVAL_MS - 1, &recovered, &unrecoverable));
  assert(recovered == 99 && unrecoverable == 99);

  // At the end of the interval the counts come out and start again from zero
  assert(fecStatusTallyTake(&tally, 5000 + FEC_STATUS_TALLY_INTERVAL_MS, &recovered, &unrecoverable));
  assert(recovered == 2 && unrecoverable == 1);
  assert(tally.recovered == 0 && tally.unrecoverable == 0);

  // An interval without reports gives no line, and the next interval starts where it ended
  assert(!fecStatusTallyTake(&tally, 5000 + 2 * FEC_STATUS_TALLY_INTERVAL_MS, &recovered, &unrecoverable));
  fecStatusTallyAdd(&tally, false);
  assert(!fecStatusTallyTake(&tally, 5000 + 3 * FEC_STATUS_TALLY_INTERVAL_MS - 1, &recovered, &unrecoverable));
  assert(fecStatusTallyTake(&tally, 5000 + 3 * FEC_STATUS_TALLY_INTERVAL_MS, &recovered, &unrecoverable));
  assert(recovered == 0 && unrecoverable == 1);

  return 0;
}
