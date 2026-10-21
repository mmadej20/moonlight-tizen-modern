// Guard for the video packet buffers, see VideoCanary.h. Diagnostic builds only.
#ifdef MOONLIGHT_VIDEO_CANARY

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifndef VIDEO_CANARY_STANDALONE
#include <pthread.h>
#include "Limelight-internal.h"
#define VIDEO_CANARY_LOG(...) Limelog(__VA_ARGS__)
#define VIDEO_CANARY_NOW_MS() PltGetMillis()
#define VIDEO_CANARY_MALLOC(size) malloc(size)
#define VIDEO_CANARY_FREE(pointer) free(pointer)
#define VIDEO_CANARY_THREAD_ID() ((uint32_t)(uintptr_t)pthread_self())
#endif

#include "VideoCanary.h"

#define REGISTRY_SLOTS 8192
#define NO_SLOT 0xFFFFu
#define GUARD_MAGIC 0xC7A5u
#define FREED_MAGIC 0xDEADu
#define PATTERN_BYTE 0xA5
#define PATTERN_SIZE 8
#define EVENT_RING 64
#define EVENTS_PRINTED 10
#define STATUS_INTERVAL_MS 30000

// The chunk head of dlmalloc: size | PINUSE (1) | CINUSE (2). PINUSE follows the neighbour in front, so it is not ours.
#define HEAD_MASK (~(uint32_t)1)

#define PROBLEM_INFO 1u
#define PROBLEM_HEAD 2u
#define PROBLEM_PATTERN 4u

// The 16 bytes behind a packet buffer
typedef struct _GUARD {
    uint32_t head;
    uint16_t slot;
    uint16_t magic;
    uint8_t pattern[PATTERN_SIZE];
} GUARD;

typedef struct _EVENT {
    const char* what;
    unsigned int a;
    unsigned int b;
    uint64_t atMs;
} EVENT;

static size_t configuredSize;
static size_t configuredEntryOffset;

static int registryLockWord;
static void* slots[REGISTRY_SLOTS];
static uint64_t slotBirthMs[REGISTRY_SLOTS];
static unsigned int liveCount;
static unsigned int mostLive;
static unsigned int cursor;

static unsigned int reports;
static unsigned int sweeps;
static unsigned int doubleFrees;
static unsigned int unregisteredByDesign;
static uint64_t lastStatusMs;

static EVENT events[EVENT_RING];
static unsigned int eventCount;

static void lockRegistry(void) {
    while (__atomic_exchange_n(&registryLockWord, 1, __ATOMIC_ACQUIRE)) {
        // The sections are a few array accesses long
    }
}

static void unlockRegistry(void) {
    __atomic_store_n(&registryLockWord, 0, __ATOMIC_RELEASE);
}

static uint32_t readWord(const void* address) {
    uint32_t value;
    memcpy(&value, address, sizeof(value));
    return value;
}

static uint32_t readHead(const void* buffer) {
    return readWord((const char*)buffer - 4);
}

static GUARD readGuard(void* buffer) {
    GUARD guard;
    memcpy(&guard, (char*)buffer + configuredSize, sizeof(guard));
    return guard;
}

static void writeGuard(void* buffer, const GUARD* guard) {
    memcpy((char*)buffer + configuredSize, guard, sizeof(*guard));
}

static unsigned int changedPatternBytes(const GUARD* guard) {
    unsigned int changed = 0;
    unsigned int i;
    for (i = 0; i < PATTERN_SIZE; i++) {
        if (guard->pattern[i] != PATTERN_BYTE) {
            changed++;
        }
    }
    return changed;
}

static unsigned int verify(void* buffer, const GUARD* guard) {
    unsigned int problems = 0;

    if (guard->magic != GUARD_MAGIC) {
        problems |= PROBLEM_INFO;
    }
    if ((readHead(buffer) & HEAD_MASK) != guard->head) {
        problems |= PROBLEM_HEAD;
    }
    if (changedPatternBytes(guard) != 0) {
        problems |= PROBLEM_PATTERN;
    }
    return problems;
}

// What was reported is taken as the new truth, so that one damage is reported once
static void adopt(void* buffer, const GUARD* old) {
    GUARD guard;
    guard.head = readHead(buffer) & HEAD_MASK;
    guard.slot = old->slot;
    guard.magic = GUARD_MAGIC;
    memset(guard.pattern, PATTERN_BYTE, sizeof(guard.pattern));
    writeGuard(buffer, &guard);
}

static void hexBytes(char* out, size_t outSize, const unsigned char* data, int count) {
    size_t used = 0;
    int i;
    for (i = 0; i < count && used + 3 < outSize; i++) {
        used += (size_t)snprintf(out + used, outSize - used, "%02x", data[i]);
    }
    if (outSize > 0) {
        out[used < outSize ? used : outSize - 1] = '\0';
    }
}

static void reportEvents(void) {
    char line[900];
    size_t used = 0;
    const unsigned int total = __atomic_load_n(&eventCount, __ATOMIC_RELAXED);
    const uint64_t now = VIDEO_CANARY_NOW_MS();
    unsigned int k;

    used += (size_t)snprintf(line, sizeof(line), "VideoCanary: recent events, newest first:");
    for (k = 1; k <= EVENTS_PRINTED && k <= total && used < sizeof(line) - 80; k++) {
        const EVENT* event = &events[(total - k) % EVENT_RING];
        used += (size_t)snprintf(line + used, sizeof(line) - used, " [%s %u %u -%llums]",
                                 event->what != NULL ? event->what : "?", event->a, event->b,
                                 (unsigned long long)(now - event->atMs));
    }
    if (total == 0) {
        snprintf(line + used, sizeof(line) - used, " none");
    }
    VIDEO_CANARY_LOG("%s\n", line);
}

static void report(const char* what, const char* where, void* buffer, unsigned int problems, const GUARD* guard,
                   uint64_t ageMs, int received, int receiveSize) {
    char before[64];
    char start[80];
    uint32_t nextHead = 0;
    const uint32_t currentHead = readHead(buffer);

    reports++;
    if (reports > 20 && reports % 1000 != 0) {
        return;
    }

    // The chunk size comes from the copy that was taken when the buffer was made. The chunk starts 8 bytes before the
    // buffer (previous footer and head), so the head of the next chunk is 4 bytes before the end of this one.
    if (guard->magic == GUARD_MAGIC && (guard->head & ~(uint32_t)7) >= 16 && (guard->head & ~(uint32_t)7) < 65536) {
        nextHead = readWord((const char*)buffer + (guard->head & ~(uint32_t)7) - 4);
    }

    hexBytes(before, sizeof(before), (const unsigned char*)buffer - 24, 24);
    hexBytes(start, sizeof(start), (const unsigned char*)buffer, 32);

    VIDEO_CANARY_LOG("VideoCanary: %s (%s): buffer 0x%lx slot %u age %llu ms, problems %u (1 info, 2 head, 4 pattern), "
                     "head 0x%08x was 0x%08x, next chunk head 0x%08x, %u of %d guard bytes changed, "
                     "received %d of %d, live %u, report %u\n",
                     what, where, (unsigned long)(uintptr_t)buffer, (unsigned int)guard->slot,
                     (unsigned long long)ageMs, problems, (unsigned int)currentHead, (unsigned int)guard->head,
                     (unsigned int)nextHead, changedPatternBytes(guard), PATTERN_SIZE, received, receiveSize,
                     liveCount, reports);
    VIDEO_CANARY_LOG("VideoCanary: 24 bytes before the head %s, first 32 bytes of the buffer %s\n", before, start);
    reportEvents();
}

void videoCanaryConfigure(size_t bufferSize, size_t entryOffset) {
    if (liveCount != 0 && bufferSize != configuredSize) {
        VIDEO_CANARY_LOG("VideoCanary: the buffer size changed from %u to %u while %u buffers are live\n",
                         (unsigned int)configuredSize, (unsigned int)bufferSize, liveCount);
    }
    configuredSize = bufferSize;
    configuredEntryOffset = entryOffset;
    VIDEO_CANARY_LOG("VideoCanary: guarding video packet buffers of %u bytes (queue entry at %u), %u still registered\n",
                     (unsigned int)bufferSize, (unsigned int)entryOffset, liveCount);
}

void videoCanaryEvent(const char* what, unsigned int a, unsigned int b) {
    const unsigned int index = __atomic_fetch_add(&eventCount, 1, __ATOMIC_RELAXED) % EVENT_RING;
    events[index].what = what;
    events[index].a = a;
    events[index].b = b;
    events[index].atMs = VIDEO_CANARY_NOW_MS();
}

void* videoCanaryMalloc(size_t bufferSize) {
    char* buffer;
    GUARD guard;
    unsigned int index;
    unsigned int slot = NO_SLOT;

    if (bufferSize != configuredSize) {
        videoCanaryConfigure(bufferSize, configuredEntryOffset);
    }

    buffer = (char*)VIDEO_CANARY_MALLOC(bufferSize + VIDEO_CANARY_SIZE);
    if (buffer == NULL) {
        return NULL;
    }

    lockRegistry();
    for (index = 0; index < REGISTRY_SLOTS; index++) {
        const unsigned int candidate = (cursor + index) % REGISTRY_SLOTS;
        if (slots[candidate] == NULL) {
            slots[candidate] = buffer;
            slotBirthMs[candidate] = VIDEO_CANARY_NOW_MS();
            slot = candidate;
            cursor = candidate + 1;
            liveCount++;
            if (liveCount > mostLive) {
                mostLive = liveCount;
            }
            break;
        }
    }
    if (slot == NO_SLOT) {
        unregisteredByDesign++;
    }
    unlockRegistry();

    guard.head = readHead(buffer) & HEAD_MASK;
    guard.slot = (uint16_t)slot;
    guard.magic = GUARD_MAGIC;
    memset(guard.pattern, PATTERN_BYTE, sizeof(guard.pattern));
    writeGuard(buffer, &guard);
    return buffer;
}

void videoCanaryCheck(void* buffer, const char* when, int received, int receiveSize) {
    GUARD guard;
    unsigned int problems;

    if (buffer == NULL) {
        return;
    }
    if (received > receiveSize) {
        VIDEO_CANARY_LOG("VideoCanary: recv returned %d, more than the %d bytes that were asked for\n", received, receiveSize);
    }
    guard = readGuard(buffer);
    problems = verify(buffer, &guard);
    if (problems == 0) {
        return;
    }
    report("a held buffer changed", when, buffer, problems, &guard, 0, received, receiveSize);
    adopt(buffer, &guard);
}

void videoCanaryFree(void* buffer, const char* where) {
    GUARD guard;
    unsigned int problems = 0;
    unsigned int index;
    unsigned int found = REGISTRY_SLOTS;
    uint64_t ageMs = 0;
    bool registeredByDesign = false;

    if (buffer == NULL) {
        return;
    }

    guard = readGuard(buffer);

    lockRegistry();
    if (guard.magic == GUARD_MAGIC && guard.slot < REGISTRY_SLOTS && slots[guard.slot] == buffer) {
        found = guard.slot;
    }
    else {
        // The slot in the guard is not to be trusted, or the buffer is not registered
        for (index = 0; index < REGISTRY_SLOTS; index++) {
            if (slots[index] == buffer) {
                found = index;
                break;
            }
        }
        registeredByDesign = found == REGISTRY_SLOTS && guard.magic == GUARD_MAGIC && guard.slot == NO_SLOT;
    }
    if (found != REGISTRY_SLOTS) {
        ageMs = VIDEO_CANARY_NOW_MS() - slotBirthMs[found];
        slots[found] = NULL;
        liveCount--;
    }
    unlockRegistry();

    if (found == REGISTRY_SLOTS && !registeredByDesign) {
        // Freeing it again would damage the heap that this is meant to find out about
        doubleFrees++;
        report("freed a buffer that is not registered (freed twice?)", where, buffer, verify(buffer, &guard), &guard, 0, 0, 0);
        return;
    }

    problems = verify(buffer, &guard);
    if (problems != 0) {
        report("a buffer was damaged while it was in use", where, buffer, problems, &guard, ageMs, 0, 0);
    }

    // A second free of the same address finds neither the registration nor the magic
    guard.magic = FREED_MAGIC;
    writeGuard(buffer, &guard);
    VIDEO_CANARY_FREE(buffer);
}

void videoCanaryFreeEntry(void* entry, void* allocPtr, const char* where) {
    if (allocPtr == NULL) {
        return;
    }
    // A fragment that was copied has an allocation of its own and the entry is its start
    if ((char*)entry == (char*)allocPtr + configuredEntryOffset) {
        videoCanaryFree(allocPtr, where);
    }
    else {
        VIDEO_CANARY_FREE(allocPtr);
    }
}

// ---- ENet blocks ----
//
// docs/2026-10-18-stream-hang-investigation.md, section 15: a frozen stream trapped in free() of an ENet packet whose
// memory was already free (a chunk of 32 bytes inside a free chunk of 808 bytes, next to the text of the stream health
// snapshot). Every block that ENet allocates is entered here, and the last frees are remembered with the thread that
// made them, so that a second free of the same block is reported together with the first one and does not reach the
// allocator.

#define ENET_SLOTS 4096
#define ENET_RING 512
#define ENET_THREADS 64
#define ENET_TOMB ((void*)1)
#define ENET_RECENT_PRINTED 6

typedef struct _ENET_BLOCK {
    void* pointer; // NULL: never used, ENET_TOMB: removed
    uint32_t size;
    uint32_t head;
    uint32_t thread;
    uint64_t atMs;
} ENET_BLOCK;

typedef struct _ENET_FREED {
    void* pointer;
    uint32_t size;
    uint32_t allocThread;
    uint32_t freeThread;
    uint64_t allocMs;
    uint64_t freeMs;
} ENET_FREED;

typedef struct _THREAD_NAME {
    uint32_t id;
    const char* name;
} THREAD_NAME;

static int enetLockWord;
static ENET_BLOCK enetBlocks[ENET_SLOTS];
static ENET_FREED enetFreed[ENET_RING];
static THREAD_NAME threadNames[ENET_THREADS];
static unsigned int threadNameCount;
static unsigned int enetFreedCount;
static unsigned int enetTombs;
static unsigned int enetLive;
static unsigned int enetMostLive;
static unsigned int enetFrees;
static unsigned int enetDoubleFrees;
static unsigned int enetBadHeads;
static unsigned int enetForeignFrees;
static unsigned int enetUntracked;
static unsigned int enetReports;

static void lockEnet(void) {
    while (__atomic_exchange_n(&enetLockWord, 1, __ATOMIC_ACQUIRE)) {
        // The sections are a few array accesses long
    }
}

static void unlockEnet(void) {
    __atomic_store_n(&enetLockWord, 0, __ATOMIC_RELEASE);
}

static unsigned int enetHash(const void* pointer) {
    return (unsigned int)((uint32_t)(((uintptr_t)pointer >> 3) * 2654435761u) % ENET_SLOTS);
}

// Returns the slot of the pointer, or -1; firstFree is the slot to insert it into
static int enetFind(const void* pointer, int* firstFree) {
    const unsigned int start = enetHash(pointer);
    unsigned int step;

    *firstFree = -1;
    for (step = 0; step < ENET_SLOTS; step++) {
        const unsigned int index = (start + step) % ENET_SLOTS;
        const void* entry = enetBlocks[index].pointer;
        if (entry == pointer) {
            return (int)index;
        }
        if (entry == NULL) {
            if (*firstFree < 0) {
                *firstFree = (int)index;
            }
            return -1;
        }
        if (entry == ENET_TOMB && *firstFree < 0) {
            *firstFree = (int)index;
        }
    }
    return -1;
}

// Removed entries lengthen the probe chains; once they are many, enter the live ones again
static void enetRebuild(void) {
    static ENET_BLOCK live[ENET_SLOTS];
    unsigned int count = 0;
    unsigned int index;

    for (index = 0; index < ENET_SLOTS; index++) {
        if (enetBlocks[index].pointer != NULL && enetBlocks[index].pointer != ENET_TOMB) {
            live[count++] = enetBlocks[index];
        }
    }
    memset(enetBlocks, 0, sizeof(enetBlocks));
    enetTombs = 0;
    for (index = 0; index < count; index++) {
        int firstFree;
        enetFind(live[index].pointer, &firstFree);
        if (firstFree >= 0) {
            enetBlocks[firstFree] = live[index];
        }
    }
}

void videoCanaryThreadName(const char* name) {
    const uint32_t id = VIDEO_CANARY_THREAD_ID();
    unsigned int index;

    lockEnet();
    for (index = 0; index < threadNameCount; index++) {
        if (threadNames[index].id == id) {
            break;
        }
    }
    if (index < ENET_THREADS) {
        threadNames[index].id = id;
        threadNames[index].name = name;
        if (index == threadNameCount) {
            threadNameCount++;
        }
    }
    unlockEnet();
}

static const char* nameOfThread(uint32_t id) {
    unsigned int index;
    for (index = 0; index < threadNameCount && index < ENET_THREADS; index++) {
        if (threadNames[index].id == id) {
            return threadNames[index].name != NULL ? threadNames[index].name : "?";
        }
    }
    return "unnamed";
}

static void enetReportRecent(void) {
    char line[900];
    size_t used = 0;
    const unsigned int total = enetFreedCount;
    const uint64_t now = VIDEO_CANARY_NOW_MS();
    unsigned int k;

    used += (size_t)snprintf(line, sizeof(line), "ENetTrace: last frees, newest first:");
    for (k = 1; k <= ENET_RECENT_PRINTED && k <= total && used < sizeof(line) - 120; k++) {
        const ENET_FREED* freed = &enetFreed[(total - k) % ENET_RING];
        used += (size_t)snprintf(line + used, sizeof(line) - used, " [0x%lx %u bytes by %s -%llums]",
                                 (unsigned long)(uintptr_t)freed->pointer, freed->size, nameOfThread(freed->freeThread),
                                 (unsigned long long)(now - freed->freeMs));
    }
    VIDEO_CANARY_LOG("%s\n", line);
}

static int enetMayReport(void) {
    enetReports++;
    return enetReports <= 20 || enetReports % 1000 == 0;
}

static void enetReportBadHead(const char* what, const ENET_BLOCK* block, uint32_t headNow, uint32_t me) {
    char before[64];
    char start[80];
    const uint64_t now = VIDEO_CANARY_NOW_MS();

    if (!enetMayReport()) {
        return;
    }
    hexBytes(before, sizeof(before), (const unsigned char*)block->pointer - 24, 24);
    hexBytes(start, sizeof(start), (const unsigned char*)block->pointer, 32);
    VIDEO_CANARY_LOG("ENetTrace: %s: block 0x%lx (%u bytes) allocated by %s %llu ms ago has chunk head 0x%08x, was 0x%08x; "
                     "seen by %s; report %u\n",
                     what, (unsigned long)(uintptr_t)block->pointer, block->size, nameOfThread(block->thread),
                     (unsigned long long)(now - block->atMs), (unsigned int)headNow, (unsigned int)block->head,
                     nameOfThread(me), enetReports);
    VIDEO_CANARY_LOG("ENetTrace: 24 bytes before the head %s, first 32 bytes of the block %s\n", before, start);
    enetReportRecent();
}

static void enetReportDoubleFree(void* pointer, const ENET_FREED* previous, uint32_t me) {
    const uint64_t now = VIDEO_CANARY_NOW_MS();

    if (!enetMayReport()) {
        return;
    }
    VIDEO_CANARY_LOG("ENetTrace: block 0x%lx (%u bytes) is freed again by %s; it was allocated by %s, lived %llu ms and "
                     "was freed by %s %llu ms ago; report %u\n",
                     (unsigned long)(uintptr_t)pointer, previous->size, nameOfThread(me),
                     nameOfThread(previous->allocThread), (unsigned long long)(previous->freeMs - previous->allocMs),
                     nameOfThread(previous->freeThread), (unsigned long long)(now - previous->freeMs), enetReports);
    enetReportRecent();
}

void* videoCanaryEnetMalloc(size_t size) {
    void* pointer = VIDEO_CANARY_MALLOC(size);
    int at;
    int firstFree;

    if (pointer == NULL) {
        return NULL;
    }

    lockEnet();
    if (enetTombs > ENET_SLOTS / 2) {
        enetRebuild();
    }
    at = enetFind(pointer, &firstFree);
    if (at < 0) {
        at = firstFree;
        if (at >= 0) {
            if (enetBlocks[at].pointer == ENET_TOMB) {
                enetTombs--;
            }
            enetLive++;
            if (enetLive > enetMostLive) {
                enetMostLive = enetLive;
            }
        }
    }
    if (at >= 0) {
        enetBlocks[at].pointer = pointer;
        enetBlocks[at].size = (uint32_t)size;
        enetBlocks[at].head = readHead(pointer) & HEAD_MASK;
        enetBlocks[at].thread = VIDEO_CANARY_THREAD_ID();
        enetBlocks[at].atMs = VIDEO_CANARY_NOW_MS();
    }
    else {
        // Not tracked, so that its free must not be taken for the second free of an earlier block at this address
        unsigned int k;
        for (k = 0; k < ENET_RING; k++) {
            if (enetFreed[k].pointer == pointer) {
                enetFreed[k].pointer = NULL;
            }
        }
        enetUntracked++;
    }
    unlockEnet();
    return pointer;
}

void videoCanaryEnetFree(void* pointer) {
    ENET_BLOCK block;
    ENET_FREED previous;
    int tracked = 0;
    int previousKnown = 0;
    const uint32_t me = VIDEO_CANARY_THREAD_ID();
    const uint64_t now = VIDEO_CANARY_NOW_MS();
    int firstFree;
    int at;

    if (pointer == NULL) {
        return;
    }

    memset(&block, 0, sizeof(block));
    memset(&previous, 0, sizeof(previous));

    lockEnet();
    at = enetFind(pointer, &firstFree);
    if (at >= 0) {
        ENET_FREED* freed = &enetFreed[enetFreedCount % ENET_RING];
        block = enetBlocks[at];
        enetBlocks[at].pointer = ENET_TOMB;
        enetTombs++;
        enetLive--;
        tracked = 1;
        freed->pointer = pointer;
        freed->size = block.size;
        freed->allocThread = block.thread;
        freed->freeThread = me;
        freed->allocMs = block.atMs;
        freed->freeMs = now;
        enetFreedCount++;
        enetFrees++;
    }
    else {
        unsigned int k;
        const unsigned int total = enetFreedCount < ENET_RING ? enetFreedCount : ENET_RING;
        for (k = 1; k <= total; k++) {
            const ENET_FREED* freed = &enetFreed[(enetFreedCount - k) % ENET_RING];
            if (freed->pointer == pointer) {
                previous = *freed;
                previousKnown = 1;
                break;
            }
        }
    }
    unlockEnet();

    if (tracked) {
        const uint32_t headNow = readHead(pointer);
        const uint32_t needed = (block.size + 4u + 7u) & ~(uint32_t)7;
        if ((headNow & 2u) == 0 || (headNow & ~(uint32_t)7) < needed || (headNow & HEAD_MASK) != block.head) {
            // Freeing a block like this would damage the heap further
            enetBadHeads++;
            enetReportBadHead("a block was damaged while it was in use", &block, headNow, me);
            return;
        }
        VIDEO_CANARY_FREE(pointer);
    }
    else if (previousKnown) {
        // Freeing it again would damage the heap that this is meant to find out about
        enetDoubleFrees++;
        enetReportDoubleFree(pointer, &previous, me);
    }
    else {
        enetForeignFrees++;
        VIDEO_CANARY_FREE(pointer);
    }
}

static void enetSweep(void) {
    ENET_BLOCK changed[4];
    uint32_t headsNow[4];
    unsigned int changedCount = 0;
    unsigned int index;

    lockEnet();
    for (index = 0; index < ENET_SLOTS; index++) {
        const void* pointer = enetBlocks[index].pointer;
        if (pointer != NULL && pointer != ENET_TOMB) {
            const uint32_t headNow = readHead(pointer);
            if ((headNow & HEAD_MASK) != enetBlocks[index].head && changedCount < 4) {
                changed[changedCount] = enetBlocks[index];
                headsNow[changedCount] = headNow;
                changedCount++;
                enetBlocks[index].head = headNow & HEAD_MASK;
            }
        }
    }
    unlockEnet();

    for (index = 0; index < changedCount; index++) {
        enetBadHeads++;
        enetReportBadHead("a live block changed", &changed[index], headsNow[index], VIDEO_CANARY_THREAD_ID());
    }
}

void videoCanarySweep(const char* when) {
    void* damaged[4];
    GUARD damagedGuard[4];
    unsigned int damagedProblems[4];
    uint64_t damagedAge[4];
    unsigned int damagedCount = 0;
    unsigned int checked = 0;
    unsigned int index;
    const uint64_t now = VIDEO_CANARY_NOW_MS();

    sweeps++;

    lockRegistry();
    for (index = 0; index < REGISTRY_SLOTS; index++) {
        void* buffer = slots[index];
        if (buffer != NULL) {
            GUARD guard = readGuard(buffer);
            const unsigned int problems = verify(buffer, &guard);
            checked++;
            if (problems != 0 && damagedCount < 4) {
                damaged[damagedCount] = buffer;
                damagedGuard[damagedCount] = guard;
                damagedProblems[damagedCount] = problems;
                damagedAge[damagedCount] = now - slotBirthMs[index];
                damagedCount++;
                adopt(buffer, &guard);
            }
        }
    }
    unlockRegistry();

    for (index = 0; index < damagedCount; index++) {
        report("a registered buffer changed", when, damaged[index], damagedProblems[index], &damagedGuard[index],
               damagedAge[index], 0, 0);
    }

    enetSweep();

    if (now - lastStatusMs >= STATUS_INTERVAL_MS) {
        lastStatusMs = now;
        VIDEO_CANARY_LOG("VideoCanary: %u buffers registered (most %u), %u sweeps, %u reports, %u double frees, %u not registered\n",
                         checked, mostLive, sweeps, reports, doubleFrees, unregisteredByDesign);
        VIDEO_CANARY_LOG("ENetTrace: %u blocks live (most %u), %u frees, %u double frees, %u bad heads, %u foreign frees, %u untracked\n",
                         enetLive, enetMostLive, enetFrees, enetDoubleFrees, enetBadHeads, enetForeignFrees, enetUntracked);
    }
}

#endif
