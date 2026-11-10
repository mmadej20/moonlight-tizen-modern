#pragma once

// Counts the frame FEC status reports (SS_FRAME_FEC_STATUS) that go to the host, so that the log shows whether the host gets the
// loss feedback it uses to adapt its packet pacing. One report describes one FEC block that needed recovery or was lost.
// Used by one thread only (the loss statistics thread), so it needs no locking.

#include <stdbool.h>
#include <stdint.h>

#define FEC_STATUS_TALLY_INTERVAL_MS 10000

typedef struct _FEC_STATUS_TALLY {
    uint32_t recovered;      // blocks that parity rebuilt
    uint32_t unrecoverable;  // blocks with too few packets to rebuild
    uint64_t intervalStartMs;
    bool started;
} FEC_STATUS_TALLY, *PFEC_STATUS_TALLY;

// A block can be rebuilt when at least as many packets arrived, data and parity together, as it has data packets.
// The counts are in host byte order.
static inline bool fecStatusBlockRecovered(uint16_t totalDataPackets, uint16_t receivedDataPackets, uint16_t receivedParityPackets) {
    return (uint32_t)receivedDataPackets + receivedParityPackets >= totalDataPackets;
}

static inline void fecStatusTallyAdd(PFEC_STATUS_TALLY tally, bool recovered) {
    if (recovered) {
        tally->recovered++;
    }
    else {
        tally->unrecoverable++;
    }
}

// Returns true when an interval is over and it had reports: the counts are then in the two outputs, and a new interval starts.
// An interval without reports gives no line, so a clean link leaves the log empty.
static inline bool fecStatusTallyTake(PFEC_STATUS_TALLY tally, uint64_t nowMs, uint32_t* recovered, uint32_t* unrecoverable) {
    if (!tally->started) {
        tally->started = true;
        tally->intervalStartMs = nowMs;
    }
    if (nowMs - tally->intervalStartMs < FEC_STATUS_TALLY_INTERVAL_MS) {
        return false;
    }
    tally->intervalStartMs = nowMs;
    if (tally->recovered == 0 && tally->unrecoverable == 0) {
        return false;
    }
    *recovered = tally->recovered;
    *unrecoverable = tally->unrecoverable;
    tally->recovered = 0;
    tally->unrecoverable = 0;
    return true;
}
