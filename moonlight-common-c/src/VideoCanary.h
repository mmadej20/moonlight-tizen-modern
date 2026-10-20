#pragma once

#include <stddef.h>
#include <stdlib.h>

// Guard for the video packet buffers (docs/2026-10-18-stream-hang-investigation.md, sections 12 and 13).
//
// A frozen stream held a live packet buffer whose heap chunk head had been overwritten. In a diagnostic build
// (MOONLIGHT_VIDEO_CANARY) every packet buffer is allocated with 16 guard bytes behind it that hold a copy of the
// chunk head, is entered in a registry of live buffers, and is checked when it is freed and every few packets by
// videoCanarySweep(). A buffer that is freed twice is reported and not freed again. In a normal build the macros
// below are plain malloc() and free(), so nothing changes.
#ifdef MOONLIGHT_VIDEO_CANARY

#define VIDEO_CANARY_SIZE 16

// bufferSize is the size of a packet buffer without the guard; entryOffset is where the queue entry starts in it
void videoCanaryConfigure(size_t bufferSize, size_t entryOffset);
void* videoCanaryMalloc(size_t bufferSize);
void videoCanaryFree(void* buffer, const char* where);
// A depacketizer entry owns either a packet buffer (the entry sits inside it) or an allocation of its own
void videoCanaryFreeEntry(void* entry, void* allocPtr, const char* where);
// Checks one buffer that the caller holds; when is "by the receive" or "while the thread held the buffer"
void videoCanaryCheck(void* buffer, const char* when, int received, int receiveSize);
// Checks every registered buffer
void videoCanarySweep(const char* when);
// Remembers what the video path just did, to be printed with the next report
void videoCanaryEvent(const char* what, unsigned int a, unsigned int b);

#define PACKET_BUFFER_CONFIGURE(size, entryOffset) videoCanaryConfigure((size), (entryOffset))
#define PACKET_BUFFER_MALLOC(size) videoCanaryMalloc(size)
#define PACKET_BUFFER_FREE(buffer) videoCanaryFree((buffer), __func__)
#define PACKET_ENTRY_FREE(entry, allocPtr) videoCanaryFreeEntry((entry), (allocPtr), __func__)
#define PACKET_BUFFER_CHECK(buffer, when, received, receiveSize) videoCanaryCheck((buffer), (when), (received), (receiveSize))
#define PACKET_BUFFER_SWEEP(when) videoCanarySweep(when)
#define PACKET_PATH_EVENT(what, a, b) videoCanaryEvent((what), (unsigned int)(a), (unsigned int)(b))

#else

#define PACKET_BUFFER_CONFIGURE(size, entryOffset) ((void)0)
#define PACKET_BUFFER_MALLOC(size) malloc(size)
#define PACKET_BUFFER_FREE(buffer) free(buffer)
#define PACKET_ENTRY_FREE(entry, allocPtr) free(allocPtr)
#define PACKET_BUFFER_CHECK(buffer, when, received, receiveSize) ((void)0)
#define PACKET_BUFFER_SWEEP(when) ((void)0)
#define PACKET_PATH_EVENT(what, a, b) ((void)0)

#endif
