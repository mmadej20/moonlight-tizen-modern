#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "moonlight-common-c/src/AudioTransportDiagnostics.h"

static void testSequenceDistance(void) {
    assert(RtpaSequenceDistance(1784, 1788) == 4);
    assert(RtpaSequenceDistance(65534, 2) == 4);
    assert(RtpaSequenceDistance(100, 100) == 0);
}

static void testRateLimitAndWindowDeltas(void) {
    RTP_AUDIO_STATS stats;
    AUDIO_TRANSPORT_DIAGNOSTICS diagnostics;
    AUDIO_TRANSPORT_SNAPSHOT snapshot;

    memset(&stats, 0, sizeof(stats));
    AudioTransportDiagnosticsReset(&diagnostics, &stats, 100);

    stats.packetCountAudio = 200;
    stats.packetCountFec = 100;
    stats.packetCountAudioInvalid = 1;
    stats.packetCountFecRecovered = 3;
    stats.packetCountFullBlockSkipped = 4;
    stats.packetCountPlc = 2;

    assert(!AudioTransportTakeSnapshot(
        &diagnostics,
        &stats,
        999,
        1000,
        false,
        &snapshot
    ));

    assert(AudioTransportTakeSnapshot(
        &diagnostics,
        &stats,
        1100,
        1000,
        false,
        &snapshot
    ));
    assert(snapshot.windowMs == 1000);
    assert(snapshot.delta.packetCountAudio == 200);
    assert(snapshot.delta.packetCountFec == 100);
    assert(snapshot.delta.packetCountAudioInvalid == 1);
    assert(snapshot.delta.packetCountFecRecovered == 3);
    assert(snapshot.delta.packetCountFullBlockSkipped == 4);
    assert(snapshot.delta.packetCountPlc == 2);
    assert(snapshot.total.packetCountAudio == 200);
    assert(snapshot.total.packetCountFecRecovered == 3);

    stats.packetCountAudio += 20;
    stats.packetCountFec += 10;
    stats.packetCountFecInvalid += 2;
    stats.packetCountOOS += 1;
    stats.packetCountFecFailed += 1;

    assert(AudioTransportTakeSnapshot(
        &diagnostics,
        &stats,
        2100,
        1000,
        false,
        &snapshot
    ));
    assert(snapshot.windowMs == 1000);
    assert(snapshot.delta.packetCountAudio == 20);
    assert(snapshot.delta.packetCountFec == 10);
    assert(snapshot.delta.packetCountFecInvalid == 2);
    assert(snapshot.delta.packetCountOOS == 1);
    assert(snapshot.delta.packetCountFecFailed == 1);
    assert(snapshot.delta.packetCountFecRecovered == 0);
    assert(snapshot.total.packetCountAudio == 220);
    assert(snapshot.total.packetCountFecFailed == 1);
}

static void testForcedPartialFlushAndEmptySuppression(void) {
    RTP_AUDIO_STATS stats;
    AUDIO_TRANSPORT_DIAGNOSTICS diagnostics;
    AUDIO_TRANSPORT_SNAPSHOT snapshot;

    memset(&stats, 0, sizeof(stats));
    AudioTransportDiagnosticsReset(&diagnostics, &stats, 500);

    assert(!AudioTransportTakeSnapshot(
        &diagnostics,
        &stats,
        700,
        1000,
        true,
        &snapshot
    ));

    stats.packetCountAudio = 1;
    assert(AudioTransportTakeSnapshot(
        &diagnostics,
        &stats,
        800,
        1000,
        true,
        &snapshot
    ));
    assert(snapshot.windowMs == 300);
    assert(snapshot.delta.packetCountAudio == 1);

    assert(!AudioTransportTakeSnapshot(
        &diagnostics,
        &stats,
        900,
        1000,
        true,
        &snapshot
    ));
}

static void testExplicitResetUsesCurrentCountersAsBaseline(void) {
    RTP_AUDIO_STATS stats;
    AUDIO_TRANSPORT_DIAGNOSTICS diagnostics;
    AUDIO_TRANSPORT_SNAPSHOT snapshot;

    memset(&stats, 0, sizeof(stats));
    stats.packetCountAudio = 50;
    stats.packetCountFecRecovered = 2;
    AudioTransportDiagnosticsReset(&diagnostics, &stats, 1000);

    stats.packetCountAudio = 51;
    stats.packetCountFecRecovered = 3;
    assert(AudioTransportTakeSnapshot(
        &diagnostics,
        &stats,
        1100,
        1000,
        true,
        &snapshot
    ));
    assert(snapshot.delta.packetCountAudio == 1);
    assert(snapshot.delta.packetCountFecRecovered == 1);
    assert(snapshot.total.packetCountAudio == 51);
}

int main(void) {
    testSequenceDistance();
    testRateLimitAndWindowDeltas();
    testForcedPartialFlushAndEmptySuppression();
    testExplicitResetUsesCurrentCountersAsBaseline();
    return 0;
}
