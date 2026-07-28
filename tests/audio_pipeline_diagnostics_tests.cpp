#include <cassert>
#include <cmath>
#include <cstdint>
#include <iterator>

#include "wasm/audio_pipeline_diagnostics.hpp"

namespace {

void AssertNear(double actual, double expected) {
  assert(std::abs(actual - expected) < 0.000001);
}

AudioPipelineSample MakeSample(
  AudioPacketOutcome outcome,
  std::uint64_t decodeUs,
  std::uint64_t appendUs,
  std::uint64_t callbackUs,
  double mediaOffsetSeconds,
  double syncLeadSeconds,
  int sessionId,
  int appendResultCode = 0,
  bool plc = false
) {
  return {
    outcome,
    plc,
    decodeUs,
    appendUs,
    callbackUs,
    mediaOffsetSeconds,
    syncLeadSeconds,
    sessionId,
    appendResultCode,
  };
}

void TestRateLimitAndAggregates() {
  AudioPipelineDiagnostics diagnostics(1'000'000);
  diagnostics.Reset(100);

  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::Appended,
      100,
      200,
      350,
      0.010,
      0.020,
      7,
      0,
      true
    ),
    500'000
  ));

  const auto snapshot = diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::AppendBufferFull,
      300,
      500,
      900,
      0.030,
      0.250,
      8,
      23
    ),
    1'000'100
  );

  assert(snapshot);
  assert(snapshot->windowUs == 1'000'000);
  assert(snapshot->packets == 2);
  assert(snapshot->appended == 1);
  assert(snapshot->appendBufferFull == 1);
  assert(snapshot->plc == 1);
  assert(snapshot->decodeSamples == 2);
  assert(snapshot->appendSamples == 2);
  assert(snapshot->callbackSamples == 2);
  assert(snapshot->decodeAvgUs == 200);
  assert(snapshot->decodeMaxUs == 300);
  assert(snapshot->appendAvgUs == 350);
  assert(snapshot->appendMaxUs == 500);
  assert(snapshot->callbackAvgUs == 625);
  assert(snapshot->callbackMaxUs == 900);
  AssertNear(snapshot->mediaOffsetSeconds, 0.030);
  AssertNear(snapshot->mediaOffsetMaxSeconds, 0.030);
  AssertNear(snapshot->syncLeadMaxSeconds, 0.250);
  assert(snapshot->sessionId == 8);
  assert(snapshot->lastAppendResultCode == 23);
}

void TestEveryOutcomeHasItsOwnCounter() {
  AudioPipelineDiagnostics diagnostics(1'000'000);
  diagnostics.Reset(0);

  const AudioPacketOutcome outcomes[] = {
    AudioPacketOutcome::Appended,
    AudioPacketOutcome::SoftDropped,
    AudioPacketOutcome::HardDropped,
    AudioPacketOutcome::DecodeFailed,
    AudioPacketOutcome::AppendIgnored,
    AudioPacketOutcome::AppendBufferFull,
    AudioPacketOutcome::AppendOtherFailure,
  };

  for (std::size_t i = 0; i < std::size(outcomes); ++i) {
    assert(!diagnostics.Record(
      MakeSample(
        outcomes[i],
        10 + i,
        20 + i,
        30 + i,
        -0.010 + static_cast<double>(i) * 0.010,
        static_cast<double>(i) * 0.020,
        12,
        static_cast<int>(i)
      ),
      100 + i
    ));
  }

  const auto snapshot = diagnostics.Flush(800);
  assert(snapshot);
  assert(snapshot->packets == 7);
  assert(snapshot->appended == 1);
  assert(snapshot->softDropped == 1);
  assert(snapshot->hardDropped == 1);
  assert(snapshot->decodeFailed == 1);
  assert(snapshot->appendIgnored == 1);
  assert(snapshot->appendBufferFull == 1);
  assert(snapshot->appendOtherFailure == 1);
  assert(snapshot->decodeSamples == 5);
  assert(snapshot->appendSamples == 4);
  assert(snapshot->callbackSamples == 7);
  AssertNear(snapshot->mediaOffsetSeconds, 0.050);
  AssertNear(snapshot->mediaOffsetMaxSeconds, 0.050);
  AssertNear(snapshot->syncLeadMaxSeconds, 0.120);
  assert(snapshot->lastAppendResultCode == 6);
}

void TestFlushAndWindowReset() {
  AudioPipelineDiagnostics diagnostics(1'000'000);
  diagnostics.Reset(100);

  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::SoftDropped,
      0,
      0,
      40,
      -0.020,
      0.210,
      3
    ),
    200
  ));

  const auto first = diagnostics.Flush(500);
  assert(first);
  assert(first->windowUs == 400);
  assert(first->softDropped == 1);
  assert(first->decodeSamples == 0);
  assert(first->appendSamples == 0);

  assert(!diagnostics.Flush(600));

  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::HardDropped,
      0,
      0,
      50,
      0.100,
      0.400,
      4
    ),
    700
  ));

  const auto second = diagnostics.Flush(900);
  assert(second);
  assert(second->windowUs == 400);
  assert(second->packets == 1);
  assert(second->softDropped == 0);
  assert(second->hardDropped == 1);
  assert(second->sessionId == 4);
}

void TestPlcCountsOnlyWhenOpusRuns() {
  AudioPipelineDiagnostics diagnostics(1'000'000);
  diagnostics.Reset(0);

  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::SoftDropped,
      0,
      0,
      10,
      0.010,
      0.210,
      4,
      0,
      true
    ),
    100
  ));
  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::HardDropped,
      0,
      0,
      10,
      0.020,
      0.400,
      4,
      0,
      true
    ),
    200
  ));
  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::DecodeFailed,
      20,
      0,
      30,
      0.030,
      0.100,
      4,
      0,
      true
    ),
    300
  ));

  const auto snapshot = diagnostics.Flush(400);
  assert(snapshot);
  assert(snapshot->packets == 3);
  assert(snapshot->plc == 1);
}

void TestExplicitResetDiscardsPreviousSession() {
  AudioPipelineDiagnostics diagnostics(1'000'000);
  diagnostics.Reset(0);
  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::AppendIgnored,
      10,
      20,
      30,
      0.010,
      0.020,
      2,
      17
    ),
    100
  ));

  diagnostics.Reset(1'000);
  assert(!diagnostics.Flush(1'100));

  assert(!diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::Appended,
      1,
      2,
      3,
      -0.030,
      0.010,
      9
    ),
    1'200
  ));
  const auto snapshot = diagnostics.Flush(1'300);
  assert(snapshot);
  assert(snapshot->packets == 1);
  assert(snapshot->appended == 1);
  assert(snapshot->appendIgnored == 0);
  assert(snapshot->sessionId == 9);
}

void TestNormalWindowsAreTenSecondsAndAnomaliesAreRateLimited() {
  AudioPipelineDiagnostics diagnostics(10'000'000, 1'000'000);
  diagnostics.Reset(0);

  assert(!diagnostics.Record(
    MakeSample(AudioPacketOutcome::Appended, 1, 2, 3, 0.010, 0.020, 1),
    1'000'000
  ));

  const auto firstAnomaly = diagnostics.Record(
    MakeSample(AudioPacketOutcome::SoftDropped, 0, 0, 4, 0.210, 0.220, 1),
    1'100'000
  );
  assert(firstAnomaly);
  assert(firstAnomaly->packets == 2);
  assert(firstAnomaly->softDropped == 1);

  assert(!diagnostics.Record(
    MakeSample(AudioPacketOutcome::HardDropped, 0, 0, 5, 0.400, 0.410, 1),
    1'500'000
  ));
  const auto coalescedAnomaly = diagnostics.Record(
    MakeSample(AudioPacketOutcome::Appended, 1, 2, 3, 0.020, 0.030, 1),
    2'100'000
  );
  assert(coalescedAnomaly);
  assert(coalescedAnomaly->packets == 2);
  assert(coalescedAnomaly->hardDropped == 1);

  assert(!diagnostics.Record(
    MakeSample(AudioPacketOutcome::Appended, 1, 2, 3, 0.020, 0.030, 1),
    12'099'999
  ));
  assert(diagnostics.Record(
    MakeSample(AudioPacketOutcome::Appended, 1, 2, 3, 0.020, 0.030, 1),
    12'100'000
  ));
}

void TestSuccessfulPlcTriggersImmediateAnomalySnapshot() {
  AudioPipelineDiagnostics diagnostics(10'000'000, 1'000'000);
  diagnostics.Reset(0);
  const auto snapshot = diagnostics.Record(
    MakeSample(
      AudioPacketOutcome::Appended,
      10,
      20,
      30,
      0.010,
      0.020,
      1,
      0,
      true
    ),
    100
  );
  assert(snapshot);
  assert(snapshot->plc == 1);
  assert(snapshot->appended == 1);
}

}  // namespace

int main() {
  TestRateLimitAndAggregates();
  TestEveryOutcomeHasItsOwnCounter();
  TestFlushAndWindowReset();
  TestPlcCountsOnlyWhenOpusRuns();
  TestExplicitResetDiscardsPreviousSession();
  TestNormalWindowsAreTenSecondsAndAnomaliesAreRateLimited();
  TestSuccessfulPlcTriggersImmediateAnomalySnapshot();
  return 0;
}
