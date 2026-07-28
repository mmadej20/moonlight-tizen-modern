#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum _VIDEO_RECEIVE_EVENT {
    VIDEO_RECEIVE_EVENT_NONE,
    VIDEO_RECEIVE_EVENT_HEARTBEAT,
    VIDEO_RECEIVE_EVENT_STALL,
    VIDEO_RECEIVE_EVENT_RECOVERY,
} VIDEO_RECEIVE_EVENT;

typedef struct _VIDEO_RECEIVE_DIAGNOSTICS {
    uint64_t windowStartMs;
    uint64_t lastPacketMs;
    uint64_t lastStallReportMs;
    uint64_t packets;
    uint64_t maxGapMs;
    bool hasPacket;
    bool stalled;
} VIDEO_RECEIVE_DIAGNOSTICS;

typedef struct _VIDEO_RECEIVE_SNAPSHOT {
    VIDEO_RECEIVE_EVENT event;
    uint64_t windowMs;
    uint64_t packets;
    uint64_t gapMs;
    uint64_t maxGapMs;
} VIDEO_RECEIVE_SNAPSHOT;

static inline void VideoReceiveDiagnosticsReset(
    VIDEO_RECEIVE_DIAGNOSTICS* diagnostics,
    uint64_t nowMs
) {
    diagnostics->windowStartMs = nowMs;
    diagnostics->lastPacketMs = nowMs;
    diagnostics->lastStallReportMs = 0;
    diagnostics->packets = 0;
    diagnostics->maxGapMs = 0;
    diagnostics->hasPacket = false;
    diagnostics->stalled = false;
}

static inline VIDEO_RECEIVE_EVENT VideoReceiveRecordPacket(
    VIDEO_RECEIVE_DIAGNOSTICS* diagnostics,
    uint64_t nowMs,
    uint64_t heartbeatIntervalMs,
    VIDEO_RECEIVE_SNAPSHOT* snapshot
) {
    uint64_t gapMs = diagnostics->hasPacket ?
        nowMs - diagnostics->lastPacketMs : 0;
    diagnostics->hasPacket = true;
    diagnostics->lastPacketMs = nowMs;
    diagnostics->packets++;
    if (gapMs > diagnostics->maxGapMs) {
        diagnostics->maxGapMs = gapMs;
    }

    VIDEO_RECEIVE_EVENT event = VIDEO_RECEIVE_EVENT_NONE;
    if (diagnostics->stalled) {
        diagnostics->stalled = false;
        event = VIDEO_RECEIVE_EVENT_RECOVERY;
    }
    else if (nowMs - diagnostics->windowStartMs >= heartbeatIntervalMs) {
        event = VIDEO_RECEIVE_EVENT_HEARTBEAT;
    }
    if (event == VIDEO_RECEIVE_EVENT_NONE) {
        return event;
    }

    snapshot->event = event;
    snapshot->windowMs = nowMs - diagnostics->windowStartMs;
    snapshot->packets = diagnostics->packets;
    snapshot->gapMs = gapMs;
    snapshot->maxGapMs = diagnostics->maxGapMs;
    diagnostics->windowStartMs = nowMs;
    diagnostics->packets = 0;
    diagnostics->maxGapMs = 0;
    return event;
}

static inline VIDEO_RECEIVE_EVENT VideoReceiveRecordTimeout(
    VIDEO_RECEIVE_DIAGNOSTICS* diagnostics,
    uint64_t nowMs,
    uint64_t stallThresholdMs,
    uint64_t stallRepeatMs,
    VIDEO_RECEIVE_SNAPSHOT* snapshot
) {
    if (!diagnostics->hasPacket ||
            nowMs - diagnostics->lastPacketMs < stallThresholdMs ||
            (diagnostics->stalled &&
             nowMs - diagnostics->lastStallReportMs < stallRepeatMs)) {
        return VIDEO_RECEIVE_EVENT_NONE;
    }
    diagnostics->stalled = true;
    diagnostics->lastStallReportMs = nowMs;
    snapshot->event = VIDEO_RECEIVE_EVENT_STALL;
    snapshot->windowMs = nowMs - diagnostics->windowStartMs;
    snapshot->packets = diagnostics->packets;
    snapshot->gapMs = nowMs - diagnostics->lastPacketMs;
    snapshot->maxGapMs = diagnostics->maxGapMs;
    return VIDEO_RECEIVE_EVENT_STALL;
}
