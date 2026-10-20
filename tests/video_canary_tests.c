// The guard for the video packet buffers (moonlight-common-c/src/VideoCanary.c). The allocator is replaced by an arena
// that has a fake chunk head in front of every buffer, so that the tests can damage it the way the frozen TV was damaged.
#define MOONLIGHT_VIDEO_CANARY 1
#define VIDEO_CANARY_STANDALONE 1

#include <assert.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SLOT_BYTES 256
#define SLOT_COUNT 9000
#define BUFFER_SIZE 64
#define ENTRY_OFFSET 40

static unsigned char arena[SLOT_COUNT][SLOT_BYTES];
static unsigned char inUse[SLOT_COUNT];
static unsigned int freeCalls;
static uint64_t fakeNow = 1000;

static char logLines[64][1100];
static int logCount;

static void testLog(const char* format, ...) __attribute__((format(printf, 1, 2)));
static void testLog(const char* format, ...) {
    va_list arguments;
    va_start(arguments, format);
    if (logCount < 64) {
        vsnprintf(logLines[logCount], sizeof(logLines[logCount]), format, arguments);
        logCount++;
    }
    va_end(arguments);
}

static void* arenaMalloc(size_t size) {
    int slot;
    for (slot = 0; slot < SLOT_COUNT; slot++) {
        if (!inUse[slot]) {
            const uint32_t head = (uint32_t)(((size + 4 + 7) & ~(size_t)7) | 3);
            unsigned char* base = arena[slot];
            inUse[slot] = 1;
            memset(base, 0x11, SLOT_BYTES);
            memcpy(base + 4, &head, sizeof(head));
            return base + 8;
        }
    }
    return NULL;
}

static void arenaFree(void* pointer) {
    const int slot = (int)(((unsigned char*)pointer - 8 - &arena[0][0]) / SLOT_BYTES);
    assert(slot >= 0 && slot < SLOT_COUNT);
    assert(inUse[slot]);
    inUse[slot] = 0;
    freeCalls++;
}

#define VIDEO_CANARY_LOG(...) testLog(__VA_ARGS__)
#define VIDEO_CANARY_NOW_MS() fakeNow
#define VIDEO_CANARY_MALLOC(size) arenaMalloc(size)
#define VIDEO_CANARY_FREE(pointer) arenaFree(pointer)

#include "moonlight-common-c/src/VideoCanary.c"

static uint32_t* headOf(void* buffer) {
    return (uint32_t*)((unsigned char*)buffer - 4);
}

static int logged(const char* text) {
    int i;
    for (i = 0; i < logCount; i++) {
        if (strstr(logLines[i], text) != NULL) {
            return 1;
        }
    }
    return 0;
}

static void clearLog(void) {
    logCount = 0;
}

int main(void) {
    char* a;
    char* b;
    char* c;
    unsigned char* own;
    int i;

    videoCanaryConfigure(BUFFER_SIZE, ENTRY_OFFSET);
    assert(logged("guarding video packet buffers of 64 bytes (queue entry at 40)"));
    clearLog();

    a = videoCanaryMalloc(BUFFER_SIZE);
    b = videoCanaryMalloc(BUFFER_SIZE);
    assert(a != NULL && b != NULL && a != b);

    // Untouched buffers are quiet
    videoCanarySweep("quiet");
    videoCanaryCheck(a, "quiet", 10, 20);
    assert(logCount == 0);

    // The bit for the neighbour in front is not ours: it changes when that neighbour is freed or allocated
    *headOf(a) ^= 1u;
    videoCanarySweep("pinuse");
    assert(logCount == 0);
    *headOf(a) ^= 1u;

    // The damage seen on the TV: the head of a live chunk became the head of a free chunk of another size
    *headOf(a) = 0x41;
    videoCanaryEvent("purge", 3, 0);
    videoCanaryEvent("recover", 41997, 2);
    videoCanarySweep("the sweep");
    assert(logged("a registered buffer changed (the sweep)"));
    assert(logged("problems 2 (1 info, 2 head, 4 pattern)"));
    assert(logged("head 0x00000041 was 0x0000005a"));
    assert(logged("recent events, newest first: [recover 41997 2 -0ms] [purge 3 0 -0ms]"));
    clearLog();

    // One damage is reported once, and freeing the buffer afterwards is quiet
    videoCanarySweep("again");
    assert(logCount == 0);
    videoCanaryFree(a, "free");
    assert(logCount == 0);
    assert(freeCalls == 1);

    // A second free of the same buffer is reported and does not reach the allocator
    videoCanaryFree(a, "free again");
    assert(logged("not registered"));
    assert(freeCalls == 1);
    clearLog();

    // Bytes behind the buffer, and a receive that returned more than it was asked for
    b[BUFFER_SIZE + 8] = 0;
    videoCanaryCheck(b, "by the receive", 10, 20);
    assert(logged("a held buffer changed (by the receive)"));
    assert(logged("problems 4"));
    clearLog();
    videoCanaryCheck(b, "by the receive", 30, 20);
    assert(logged("recv returned 30, more than the 20 bytes that were asked for"));
    clearLog();

    // A buffer that was damaged and then freed is reported with its age
    *headOf(b) = 0x59;
    fakeNow += 250;
    videoCanaryFree(b, "free damaged");
    assert(logged("a buffer was damaged while it was in use (free damaged)"));
    assert(logged("age 250 ms"));
    assert(freeCalls == 2);
    clearLog();

    // An entry inside a packet buffer frees the buffer through the guard; an entry with an allocation of its own does not
    c = videoCanaryMalloc(BUFFER_SIZE);
    videoCanaryFreeEntry(c + ENTRY_OFFSET, c, "entry");
    assert(freeCalls == 3);
    assert(logCount == 0);
    own = arenaMalloc(100);
    videoCanaryFreeEntry(own, own, "own entry");
    assert(freeCalls == 4);
    assert(logCount == 0);
    videoCanaryFreeEntry(NULL, NULL, "nothing");
    assert(freeCalls == 4);

    // More buffers than the registry holds still work, they are just not watched
    {
        static char* many[REGISTRY_SLOTS + 5];
        for (i = 0; i < REGISTRY_SLOTS + 5; i++) {
            many[i] = videoCanaryMalloc(BUFFER_SIZE);
            assert(many[i] != NULL);
        }
        assert(liveCount == REGISTRY_SLOTS);
        assert(unregisteredByDesign == 5);
        videoCanarySweep("many");
        assert(logCount == 0);
        for (i = 0; i < REGISTRY_SLOTS + 5; i++) {
            videoCanaryFree(many[i], "many");
        }
        assert(liveCount == 0);
        assert(logCount == 0);
        assert(freeCalls == 4 + REGISTRY_SLOTS + 5);
    }

    // A status line now and then shows that the guard is running
    fakeNow += 40000;
    videoCanarySweep("status");
    assert(logged("buffers registered"));

    puts("video canary tests passed");
    return 0;
}
