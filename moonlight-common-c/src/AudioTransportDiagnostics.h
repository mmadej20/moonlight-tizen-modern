#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

typedef struct _RTP_AUDIO_STATS {
    uint64_t packetCountAudio;
    uint64_t packetCountFec;
    uint64_t packetCountAudioInvalid;
    uint64_t packetCountFecInvalid;
    uint64_t packetCountOOS;
    uint64_t packetCountFecRecovered;
    uint64_t packetCountFecFailed;
    uint64_t packetCountFullBlockSkipped;
    uint64_t packetCountPlc;
} RTP_AUDIO_STATS, *PRTP_AUDIO_STATS;

typedef struct _AUDIO_TRANSPORT_DIAGNOSTICS {
    uint64_t windowStartMs;
    RTP_AUDIO_STATS previous;
} AUDIO_TRANSPORT_DIAGNOSTICS, *PAUDIO_TRANSPORT_DIAGNOSTICS;

typedef struct _AUDIO_TRANSPORT_SNAPSHOT {
    uint64_t windowMs;
    RTP_AUDIO_STATS delta;
    RTP_AUDIO_STATS total;
} AUDIO_TRANSPORT_SNAPSHOT, *PAUDIO_TRANSPORT_SNAPSHOT;

static inline uint16_t RtpaSequenceDistance(uint16_t from, uint16_t to) {
    return (uint16_t)(to - from);
}

static inline void AudioTransportDiagnosticsReset(
    PAUDIO_TRANSPORT_DIAGNOSTICS diagnostics,
    const RTP_AUDIO_STATS* current,
    uint64_t nowMs
) {
    diagnostics->windowStartMs = nowMs;
    diagnostics->previous = *current;
}

static inline bool AudioTransportStatsHaveActivity(
    const RTP_AUDIO_STATS* stats
) {
    return stats->packetCountAudio != 0 ||
            stats->packetCountFec != 0 ||
            stats->packetCountAudioInvalid != 0 ||
            stats->packetCountFecInvalid != 0 ||
            stats->packetCountOOS != 0 ||
            stats->packetCountFecRecovered != 0 ||
            stats->packetCountFecFailed != 0 ||
            stats->packetCountFullBlockSkipped != 0 ||
            stats->packetCountPlc != 0;
}

static inline bool AudioTransportTakeSnapshot(
    PAUDIO_TRANSPORT_DIAGNOSTICS diagnostics,
    const RTP_AUDIO_STATS* current,
    uint64_t nowMs,
    uint64_t reportIntervalMs,
    bool force,
    PAUDIO_TRANSPORT_SNAPSHOT snapshot
) {
    RTP_AUDIO_STATS delta;

    if (!force &&
            nowMs - diagnostics->windowStartMs < reportIntervalMs) {
        return false;
    }

#define AUDIO_STATS_DELTA(field) \
    delta.field = current->field - diagnostics->previous.field
    AUDIO_STATS_DELTA(packetCountAudio);
    AUDIO_STATS_DELTA(packetCountFec);
    AUDIO_STATS_DELTA(packetCountAudioInvalid);
    AUDIO_STATS_DELTA(packetCountFecInvalid);
    AUDIO_STATS_DELTA(packetCountOOS);
    AUDIO_STATS_DELTA(packetCountFecRecovered);
    AUDIO_STATS_DELTA(packetCountFecFailed);
    AUDIO_STATS_DELTA(packetCountFullBlockSkipped);
    AUDIO_STATS_DELTA(packetCountPlc);
#undef AUDIO_STATS_DELTA

    if (!AudioTransportStatsHaveActivity(&delta)) {
        return false;
    }

    snapshot->windowMs = nowMs - diagnostics->windowStartMs;
    snapshot->delta = delta;
    snapshot->total = *current;
    diagnostics->windowStartMs = nowMs;
    diagnostics->previous = *current;
    return true;
}
