#pragma once

#include <string>

inline const char* MediaTrackCloseReasonName(int reason) {
  switch (reason) {
    case 0:
      return "kSourceClosed";
    case 1:
      return "kSourceError";
    case 2:
      return "kSourceDetached";
    case 3:
      return "kSourceSuspended";
    case 4:
      return "kTrackDisabled";
    case 5:
      return "kTrackEnded";
    case 6:
      return "kTrackSeeking";
    case 7:
      return "kUnknown";
    default:
      return "unrecognized";
  }
}

inline std::string FormatMediaTrackOpen(
  const char* track,
  int storedSession,
  bool currentSessionAvailable,
  int currentSession,
  int currentSessionError
) {
  std::string message =
    std::string(track) +
    " track open storedSession=" +
    std::to_string(storedSession);
  if (currentSessionAvailable) {
    return message + " currentSession=" + std::to_string(currentSession);
  }

  return message +
    " currentSessionError=" +
    std::to_string(currentSessionError);
}

inline std::string FormatMediaTrackClosed(
  const char* track,
  int closeReason,
  int storedSession
) {
  return std::string(track) +
    " track closed reason=" +
    MediaTrackCloseReasonName(closeReason) +
    "(" +
    std::to_string(closeReason) +
    ") storedSession=" +
    std::to_string(storedSession);
}

inline std::string FormatMediaTrackSessionChanged(
  const char* track,
  int oldSession,
  int newSession
) {
  return std::string(track) +
    " session changed old=" +
    std::to_string(oldSession) +
    " new=" +
    std::to_string(newSession);
}
