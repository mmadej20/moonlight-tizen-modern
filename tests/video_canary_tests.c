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
static uint32_t fakeThread = 1;

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

static void* forcedNext;

static unsigned int inUseCount(void) {
    unsigned int count = 0;
    int slot;
    for (slot = 0; slot < SLOT_COUNT; slot++) {
        count += inUse[slot] != 0;
    }
    return count;
}

static void* arenaMalloc(size_t size) {
    int slot;

    // A block that the allocator should not have returned, for the test of the overlap check
    if (forcedNext != NULL) {
        return forcedNext;
    }
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
#define VIDEO_CANARY_THREAD_ID() fakeThread

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

    // The blocks of ENet: a red zone on both sides, a pattern in a freed block that is kept for a while, the thread that
    // allocates and the one that frees named in the reports
    {
        void* first;
        void* second;
        void* third;
        void* foreign;
        void* tracked[ENET_SLOTS + 100];
        const unsigned int freesBefore = freeCalls;
        const unsigned int foreignBefore = enetForeignFrees;
        const unsigned int liveBefore = enetLive;
        const unsigned int inUseBefore = inUseCount();
        unsigned int untrackedBefore;

        // Taken now, while no block of ENet was freed yet, so that no free of ENet has been at its address
        foreign = arenaMalloc(24);

        fakeThread = 100;
        videoCanaryThreadName("sender");
        fakeThread = 200;
        videoCanaryThreadName("control");
        assert(strcmp(nameOfThread(100), "sender") == 0);
        assert(strcmp(nameOfThread(999), "unnamed") == 0);

        fakeThread = 100;
        first = videoCanaryEnetMalloc(24);
        assert(first != NULL);
        assert(((unsigned char*)first)[-1] == 0xA5 && ((unsigned char*)first)[24] == 0x5A);
        fakeNow += 30;
        fakeThread = 200;
        videoCanaryEnetFree(first);
        assert(freeCalls == freesBefore); // held, not freed
        assert(((unsigned char*)first)[0] == 0xDD && ((unsigned char*)first)[23] == 0xDD);
        assert(logCount == 0);

        fakeNow += 5;
        fakeThread = 100;
        videoCanaryEnetFree(first);
        assert(freeCalls == freesBefore);
        assert(logged("is freed again by sender; it was allocated by sender, lived 30 ms and was freed by control 5 ms ago"));
        assert(logged("last frees, newest first: [0x"));
        assert(enetDoubleFrees == 1);
        clearLog();

        // A write to a freed block is found when the block leaves the quarantine
        ((unsigned char*)first)[3] = 0x11;
        enetFlushHeld();
        assert(logged("a block was written after it was freed: block 0x"));
        assert(logged("freed by control 5 ms ago, 1 bytes changed (first at offset 3), red zones intact"));
        assert(freeCalls == freesBefore + 1);
        clearLog();

        // A live block whose chunk head says "free" is reported and left alone
        second = videoCanaryEnetMalloc(24);
        *headOf((char*)second - 16) = 0x41;
        videoCanaryEnetFree(second);
        assert(logged("a block was damaged while it was in use: block 0x"));
        assert(logged("the chunk head is 0x00000041, was 0x00000042"));
        assert(freeCalls == freesBefore + 1);
        clearLog();

        // A change of the head is found by the sweep, once, and the block can be freed afterwards
        third = videoCanaryEnetMalloc(24);
        *headOf((char*)third - 16) = 0x4b;
        videoCanarySweep("enet");
        assert(logged("a live block changed: block 0x"));
        assert(logged("the chunk head is 0x0000004b, was 0x00000042"));
        clearLog();
        videoCanarySweep("enet again");
        assert(!logged("a live block changed"));
        videoCanaryEnetFree(third);
        assert(logCount == 0);

        // The bit for the neighbour in front is not ours
        third = videoCanaryEnetMalloc(24);
        *headOf((char*)third - 16) ^= 1u;
        videoCanarySweep("enet pinuse");
        assert(!logged("a live block changed"));
        videoCanaryEnetFree(third);
        assert(logCount == 0);

        // The red zones: an overrun of a block is found by the sweep, an underrun when the block is freed
        third = videoCanaryEnetMalloc(24);
        ((unsigned char*)third)[24] = 0;
        videoCanarySweep("enet zone");
        assert(logged("a live block changed: block 0x"));
        assert(logged("the red zone behind the block was written"));
        clearLog();
        videoCanaryEnetFree(third);
        assert(logCount == 0);
        third = videoCanaryEnetMalloc(24);
        ((unsigned char*)third)[-2] = 0;
        videoCanaryEnetFree(third);
        assert(logged("a block was written outside its bounds: block 0x"));
        assert(logged("the red zone in front of the block was written"));
        clearLog();

        // A pointer that ENet did not allocate is passed to the allocator
        videoCanaryEnetFree(foreign);
        assert(enetForeignFrees == foreignBefore + 1);
        videoCanaryEnetFree(NULL);

        // More blocks than the table holds are not tracked, and blocks that come and go do not slow it down
        untrackedBefore = enetUntracked;
        for (i = 0; i < ENET_SLOTS + 100; i++) {
            tracked[i] = videoCanaryEnetMalloc(24);
            assert(tracked[i] != NULL);
        }
        assert(enetLive == ENET_SLOTS);
        assert(enetUntracked == untrackedBefore + 100 + liveBefore);
        for (i = 0; i < ENET_SLOTS + 100; i++) {
            videoCanaryEnetFree(tracked[i]);
        }
        assert(enetLive == liveBefore);
        for (i = 0; i < 20000; i++) {
            void* block = videoCanaryEnetMalloc(24);
            assert(block != NULL);
            videoCanaryEnetFree(block);
        }
        assert(enetLive == liveBefore);
        assert(enetTombs <= ENET_SLOTS);
        enetFlushHeld();
        assert(inUseCount() <= inUseBefore + 3);
        clearLog();

        // The allocator returns memory that overlaps a block in use
        first = videoCanaryEnetMalloc(24);
        forcedNext = (char*)first - ENET_ZONE + 8;
        second = videoCanaryEnetMalloc(24);
        forcedNext = NULL;
        assert(logged("overlapping allocation: block 0x"));
        assert(logged("the allocator returned memory that overlaps the block 0x"));
        assert(logged("which is still in use"));
        assert(enetOverlaps == 1);
        assert(second != NULL);
        clearLog();
    }

    // A status line now and then shows that the guard is running
    fakeNow += 40000;
    videoCanarySweep("status");
    assert(logged("buffers registered"));
    assert(logged("ENetTrace: ") && logged("blocks live"));

    puts("video canary tests passed");
    return 0;
}
