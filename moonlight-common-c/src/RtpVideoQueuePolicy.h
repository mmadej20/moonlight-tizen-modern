#pragma once

#include <stdbool.h>

static inline bool shouldUseSpeculativeRfi(bool frameAlreadyReportedLost,
                                           bool receivedOosData,
                                           bool rfiEnabled,
                                           unsigned int missingPackets,
                                           unsigned int recoverablePackets) {
    return !frameAlreadyReportedLost &&
           !receivedOosData &&
           rfiEnabled &&
           missingPackets > recoverablePackets;
}
