#include <assert.h>

#include "moonlight-common-c/src/VideoReceiveDiagnostics.h"

int main(void) {
    VIDEO_RECEIVE_DIAGNOSTICS diagnostics;
    VIDEO_RECEIVE_SNAPSHOT snapshot;
    VideoReceiveDiagnosticsReset(&diagnostics, 0);

    assert(VideoReceiveRecordPacket(&diagnostics, 100, 10000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_NONE);
    assert(VideoReceiveRecordPacket(&diagnostics, 10100, 10000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_HEARTBEAT);
    assert(snapshot.packets == 2);
    assert(snapshot.maxGapMs == 10000);

    assert(VideoReceiveRecordTimeout(&diagnostics, 11099, 1000, 5000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_NONE);
    assert(VideoReceiveRecordTimeout(&diagnostics, 11100, 1000, 5000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_STALL);
    assert(snapshot.gapMs == 1000);
    assert(VideoReceiveRecordTimeout(&diagnostics, 12000, 1000, 5000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_NONE);
    assert(VideoReceiveRecordTimeout(&diagnostics, 16100, 1000, 5000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_STALL);

    assert(VideoReceiveRecordPacket(&diagnostics, 16200, 10000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_RECOVERY);
    assert(snapshot.gapMs == 6100);
    assert(VideoReceiveRecordPacket(&diagnostics, 16201, 10000, &snapshot) ==
        VIDEO_RECEIVE_EVENT_NONE);
    return 0;
}
