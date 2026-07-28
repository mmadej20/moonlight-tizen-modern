#pragma once

#include <algorithm>
#include <cstdint>
#include <optional>

enum class AudioPacketOutcome {
  Appended,
  SoftDropped,
  HardDropped,
  DecodeFailed,
  AppendIgnored,
  AppendBufferFull,
  AppendOtherFailure,
};

struct AudioPipelineSample {
  AudioPacketOutcome outcome;
  bool plc;
  std::uint64_t decodeUs;
  std::uint64_t appendUs;
  std::uint64_t callbackUs;
  double mediaOffsetSeconds;
  double syncLeadSeconds;
  int sessionId;
  int appendResultCode;
};

struct AudioPipelineSnapshot {
  std::uint64_t windowUs = 0;
  std::uint64_t packets = 0;
  std::uint64_t appended = 0;
  std::uint64_t plc = 0;
  std::uint64_t softDropped = 0;
  std::uint64_t hardDropped = 0;
  std::uint64_t decodeFailed = 0;
  std::uint64_t appendIgnored = 0;
  std::uint64_t appendBufferFull = 0;
  std::uint64_t appendOtherFailure = 0;
  std::uint64_t decodeSamples = 0;
  std::uint64_t decodeAvgUs = 0;
  std::uint64_t decodeMaxUs = 0;
  std::uint64_t appendSamples = 0;
  std::uint64_t appendAvgUs = 0;
  std::uint64_t appendMaxUs = 0;
  std::uint64_t callbackSamples = 0;
  std::uint64_t callbackAvgUs = 0;
  std::uint64_t callbackMaxUs = 0;
  double mediaOffsetSeconds = 0.0;
  double mediaOffsetMaxSeconds = 0.0;
  double syncLeadMaxSeconds = 0.0;
  int sessionId = 0;
  int lastAppendResultCode = 0;
};

class AudioPipelineDiagnostics {
 public:
  AudioPipelineDiagnostics()
    : reportIntervalUs_(10'000'000),
      anomalyIntervalUs_(1'000'000),
      anomalyReportsEnabled_(true) {}

  explicit AudioPipelineDiagnostics(std::uint64_t reportIntervalUs)
    : reportIntervalUs_(reportIntervalUs),
      anomalyIntervalUs_(reportIntervalUs),
      anomalyReportsEnabled_(false) {}

  AudioPipelineDiagnostics(
    std::uint64_t reportIntervalUs,
    std::uint64_t anomalyIntervalUs
  ) : reportIntervalUs_(reportIntervalUs),
      anomalyIntervalUs_(anomalyIntervalUs),
      anomalyReportsEnabled_(true) {}

  void Reset(std::uint64_t nowUs) {
    started_ = true;
    windowStartUs_ = nowUs;
    hasAnomalyReport_ = false;
    lastAnomalyReportUs_ = 0;
    ResetWindow();
  }

  std::optional<AudioPipelineSnapshot> Record(
    const AudioPipelineSample& sample,
    std::uint64_t nowUs
  ) {
    if (!started_) {
      Reset(nowUs);
    }

    Accumulate(sample);
    const bool normalReportDue =
      nowUs - windowStartUs_ >= reportIntervalUs_;
    const bool anomalyReportDue = anomalyReportsEnabled_ &&
      windowHasAnomaly_ &&
      (!hasAnomalyReport_ ||
       nowUs - lastAnomalyReportUs_ >= anomalyIntervalUs_);
    if (!normalReportDue && !anomalyReportDue) {
      return std::nullopt;
    }

    return TakeSnapshot(nowUs);
  }

  std::optional<AudioPipelineSnapshot> Flush(std::uint64_t nowUs) {
    if (!started_ || packets_ == 0) {
      return std::nullopt;
    }

    return TakeSnapshot(nowUs);
  }

 private:
  static bool DecodeRan(AudioPacketOutcome outcome) {
    return outcome != AudioPacketOutcome::SoftDropped &&
           outcome != AudioPacketOutcome::HardDropped;
  }

  static bool AppendRan(AudioPacketOutcome outcome) {
    return outcome == AudioPacketOutcome::Appended ||
           outcome == AudioPacketOutcome::AppendIgnored ||
           outcome == AudioPacketOutcome::AppendBufferFull ||
           outcome == AudioPacketOutcome::AppendOtherFailure;
  }

  static bool AppendFailed(AudioPacketOutcome outcome) {
    return outcome == AudioPacketOutcome::AppendIgnored ||
           outcome == AudioPacketOutcome::AppendBufferFull ||
           outcome == AudioPacketOutcome::AppendOtherFailure;
  }

  void Accumulate(const AudioPipelineSample& sample) {
    ++packets_;
    if (sample.plc && DecodeRan(sample.outcome)) {
      ++plc_;
    }

    switch (sample.outcome) {
      case AudioPacketOutcome::Appended:
        ++appended_;
        break;
      case AudioPacketOutcome::SoftDropped:
        ++softDropped_;
        break;
      case AudioPacketOutcome::HardDropped:
        ++hardDropped_;
        break;
      case AudioPacketOutcome::DecodeFailed:
        ++decodeFailed_;
        break;
      case AudioPacketOutcome::AppendIgnored:
        ++appendIgnored_;
        break;
      case AudioPacketOutcome::AppendBufferFull:
        ++appendBufferFull_;
        break;
      case AudioPacketOutcome::AppendOtherFailure:
        ++appendOtherFailure_;
        break;
    }

    if (DecodeRan(sample.outcome)) {
      ++decodeSamples_;
      decodeTotalUs_ += sample.decodeUs;
      decodeMaxUs_ = std::max(decodeMaxUs_, sample.decodeUs);
    }

    if (AppendRan(sample.outcome)) {
      ++appendSamples_;
      appendTotalUs_ += sample.appendUs;
      appendMaxUs_ = std::max(appendMaxUs_, sample.appendUs);
    }

    ++callbackSamples_;
    callbackTotalUs_ += sample.callbackUs;
    callbackMaxUs_ = std::max(callbackMaxUs_, sample.callbackUs);

    mediaOffsetSeconds_ = sample.mediaOffsetSeconds;
    if (!hasMediaOffset_) {
      mediaOffsetMaxSeconds_ = sample.mediaOffsetSeconds;
      hasMediaOffset_ = true;
    } else {
      mediaOffsetMaxSeconds_ = std::max(
        mediaOffsetMaxSeconds_,
        sample.mediaOffsetSeconds
      );
    }
    syncLeadMaxSeconds_ = std::max(
      syncLeadMaxSeconds_,
      sample.syncLeadSeconds
    );
    sessionId_ = sample.sessionId;

    if (AppendFailed(sample.outcome)) {
      lastAppendResultCode_ = sample.appendResultCode;
    }
    if (sample.outcome != AudioPacketOutcome::Appended) {
      windowHasAnomaly_ = true;
    }
  }

  std::optional<AudioPipelineSnapshot> TakeSnapshot(std::uint64_t nowUs) {
    AudioPipelineSnapshot snapshot;
    snapshot.windowUs = nowUs - windowStartUs_;
    snapshot.packets = packets_;
    snapshot.appended = appended_;
    snapshot.plc = plc_;
    snapshot.softDropped = softDropped_;
    snapshot.hardDropped = hardDropped_;
    snapshot.decodeFailed = decodeFailed_;
    snapshot.appendIgnored = appendIgnored_;
    snapshot.appendBufferFull = appendBufferFull_;
    snapshot.appendOtherFailure = appendOtherFailure_;
    snapshot.decodeSamples = decodeSamples_;
    snapshot.decodeAvgUs =
      decodeSamples_ == 0 ? 0 : decodeTotalUs_ / decodeSamples_;
    snapshot.decodeMaxUs = decodeMaxUs_;
    snapshot.appendSamples = appendSamples_;
    snapshot.appendAvgUs =
      appendSamples_ == 0 ? 0 : appendTotalUs_ / appendSamples_;
    snapshot.appendMaxUs = appendMaxUs_;
    snapshot.callbackSamples = callbackSamples_;
    snapshot.callbackAvgUs =
      callbackSamples_ == 0 ? 0 : callbackTotalUs_ / callbackSamples_;
    snapshot.callbackMaxUs = callbackMaxUs_;
    snapshot.mediaOffsetSeconds = mediaOffsetSeconds_;
    snapshot.mediaOffsetMaxSeconds = mediaOffsetMaxSeconds_;
    snapshot.syncLeadMaxSeconds = syncLeadMaxSeconds_;
    snapshot.sessionId = sessionId_;
    snapshot.lastAppendResultCode = lastAppendResultCode_;

    if (windowHasAnomaly_) {
      hasAnomalyReport_ = true;
      lastAnomalyReportUs_ = nowUs;
    }
    windowStartUs_ = nowUs;
    ResetWindow();
    return snapshot;
  }

  void ResetWindow() {
    packets_ = 0;
    appended_ = 0;
    plc_ = 0;
    softDropped_ = 0;
    hardDropped_ = 0;
    decodeFailed_ = 0;
    appendIgnored_ = 0;
    appendBufferFull_ = 0;
    appendOtherFailure_ = 0;
    decodeSamples_ = 0;
    decodeTotalUs_ = 0;
    decodeMaxUs_ = 0;
    appendSamples_ = 0;
    appendTotalUs_ = 0;
    appendMaxUs_ = 0;
    callbackSamples_ = 0;
    callbackTotalUs_ = 0;
    callbackMaxUs_ = 0;
    mediaOffsetSeconds_ = 0.0;
    mediaOffsetMaxSeconds_ = 0.0;
    hasMediaOffset_ = false;
    syncLeadMaxSeconds_ = 0.0;
    sessionId_ = 0;
    lastAppendResultCode_ = 0;
    windowHasAnomaly_ = false;
  }

  const std::uint64_t reportIntervalUs_;
  const std::uint64_t anomalyIntervalUs_;
  const bool anomalyReportsEnabled_;
  bool started_ = false;
  bool hasAnomalyReport_ = false;
  bool windowHasAnomaly_ = false;
  std::uint64_t lastAnomalyReportUs_ = 0;
  std::uint64_t windowStartUs_ = 0;
  std::uint64_t packets_ = 0;
  std::uint64_t appended_ = 0;
  std::uint64_t plc_ = 0;
  std::uint64_t softDropped_ = 0;
  std::uint64_t hardDropped_ = 0;
  std::uint64_t decodeFailed_ = 0;
  std::uint64_t appendIgnored_ = 0;
  std::uint64_t appendBufferFull_ = 0;
  std::uint64_t appendOtherFailure_ = 0;
  std::uint64_t decodeSamples_ = 0;
  std::uint64_t decodeTotalUs_ = 0;
  std::uint64_t decodeMaxUs_ = 0;
  std::uint64_t appendSamples_ = 0;
  std::uint64_t appendTotalUs_ = 0;
  std::uint64_t appendMaxUs_ = 0;
  std::uint64_t callbackSamples_ = 0;
  std::uint64_t callbackTotalUs_ = 0;
  std::uint64_t callbackMaxUs_ = 0;
  double mediaOffsetSeconds_ = 0.0;
  double mediaOffsetMaxSeconds_ = 0.0;
  bool hasMediaOffset_ = false;
  double syncLeadMaxSeconds_ = 0.0;
  int sessionId_ = 0;
  int lastAppendResultCode_ = 0;
};
