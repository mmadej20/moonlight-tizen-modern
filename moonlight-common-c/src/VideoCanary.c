// Guard for the video packet buffers, see VideoCanary.h. Diagnostic builds only.
#ifdef MOONLIGHT_VIDEO_CANARY

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifndef VIDEO_CANARY_STANDALONE
#include "Limelight-internal.h"
#define VIDEO_CANARY_LOG(...) Limelog(__VA_ARGS__)
#define VIDEO_CANARY_NOW_MS() PltGetMillis()
#define VIDEO_CANARY_MALLOC(size) malloc(size)
#define VIDEO_CANARY_FREE(pointer) free(pointer)
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

    if (now - lastStatusMs >= STATUS_INTERVAL_MS) {
        lastStatusMs = now;
        VIDEO_CANARY_LOG("VideoCanary: %u buffers registered (most %u), %u sweeps, %u reports, %u double frees, %u not registered\n",
                         checked, mostLive, sweeps, reports, doubleFrees, unregisteredByDesign);
    }
}

#endif
