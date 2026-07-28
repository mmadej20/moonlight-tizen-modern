#pragma once

#include <algorithm>
#include <cstddef>

enum class AudioSyncDecision {
  Append,
  DropSoft,
  DropHard,
};

class AudioSyncController {
 public:
  AudioSyncController(double highWatermarkSeconds,
                      double lowWatermarkSeconds,
                      double hardWatermarkSeconds,
                      std::size_t softDropInterval)
      : highWatermarkSeconds_(highWatermarkSeconds),
        lowWatermarkSeconds_(lowWatermarkSeconds),
        hardWatermarkSeconds_(hardWatermarkSeconds),
        softDropInterval_(softDropInterval) {}

  AudioSyncDecision ObservePacket(double nowSeconds) {
    const double leadSeconds = EstimatedLead(nowSeconds);
    if (leadSeconds >= hardWatermarkSeconds_) {
      return AudioSyncDecision::DropHard;
    }

    if (softCorrectionActive_ && leadSeconds <= lowWatermarkSeconds_) {
      softCorrectionActive_ = false;
      softPacketCount_ = 0;
    } else if (!softCorrectionActive_ && leadSeconds >= highWatermarkSeconds_) {
      softCorrectionActive_ = true;
      softPacketCount_ = 0;
    }

    if (!softCorrectionActive_ || softDropInterval_ == 0) {
      return AudioSyncDecision::Append;
    }

    ++softPacketCount_;
    if (softPacketCount_ < softDropInterval_) {
      return AudioSyncDecision::Append;
    }

    softPacketCount_ = 0;
    return AudioSyncDecision::DropSoft;
  }

  void CommitAppend(double nowSeconds, double durationSeconds) {
    estimatedEndSeconds_ =
        std::max(estimatedEndSeconds_, nowSeconds) + durationSeconds;
  }

  double EstimatedLead(double nowSeconds) const {
    return std::max(0.0, estimatedEndSeconds_ - nowSeconds);
  }

  void Reset() {
    estimatedEndSeconds_ = 0.0;
    softCorrectionActive_ = false;
    softPacketCount_ = 0;
  }

 private:
  const double highWatermarkSeconds_;
  const double lowWatermarkSeconds_;
  const double hardWatermarkSeconds_;
  const std::size_t softDropInterval_;

  double estimatedEndSeconds_ = 0.0;
  bool softCorrectionActive_ = false;
  std::size_t softPacketCount_ = 0;
};
