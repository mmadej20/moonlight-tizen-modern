#include "wasm/owned_pthread.hpp"

#include <atomic>
#include <cassert>
#include <cerrno>
#include <condition_variable>
#include <mutex>
#include <thread>

namespace {

void* CountWorker(void* context) {
  static_cast<std::atomic<int>*>(context)->fetch_add(1);
  return nullptr;
}

struct BlockingWorkerContext {
  std::mutex mutex;
  std::condition_variable cv;
  bool started = false;
  bool release = false;
  std::atomic<int> calls{0};
};

void* BlockingWorker(void* rawContext) {
  auto* context = static_cast<BlockingWorkerContext*>(rawContext);
  {
    std::unique_lock<std::mutex> lock(context->mutex);
    context->started = true;
    ++context->calls;
    context->cv.notify_all();
    context->cv.wait(lock, [&] { return context->release; });
  }
  return nullptr;
}

struct SelfJoinContext {
  OwnedPthread* owner = nullptr;
  std::mutex mutex;
  std::condition_variable cv;
  bool completed = false;
  int result = 0;
};

void* SelfJoinWorker(void* rawContext) {
  auto* context = static_cast<SelfJoinContext*>(rawContext);
  const int result = context->owner->Join();
  {
    std::lock_guard<std::mutex> lock(context->mutex);
    context->result = result;
    context->completed = true;
  }
  context->cv.notify_all();
  return nullptr;
}

}  // namespace

int main() {
  OwnedPthread publicationOwner;
  std::mutex publicationMutex;
  std::condition_variable publicationCv;
  bool creationEntered = false;
  bool joinAttempted = false;
  bool allowCreate = false;
  std::atomic<int> publicationCalls{0};
  int createResult = -1;
  int publicationJoinResult = -1;

  std::thread creator([&] {
    createResult = publicationOwner.CreateWith(
        CountWorker, &publicationCalls,
        [&](pthread_t* thread, const pthread_attr_t* attributes,
            OwnedPthread::ThreadFunction function, void* argument) {
          {
            std::unique_lock<std::mutex> lock(publicationMutex);
            creationEntered = true;
            publicationCv.notify_all();
            publicationCv.wait(lock, [&] { return allowCreate; });
          }
          return pthread_create(thread, attributes, function, argument);
        });
  });

  {
    std::unique_lock<std::mutex> lock(publicationMutex);
    publicationCv.wait(lock, [&] { return creationEntered; });
  }
  assert(publicationOwner.state() == PthreadOwnershipState::Creating);

  std::thread publicationJoiner([&] {
    {
      std::lock_guard<std::mutex> lock(publicationMutex);
      joinAttempted = true;
    }
    publicationCv.notify_all();
    publicationJoinResult = publicationOwner.Join();
  });

  {
    std::unique_lock<std::mutex> lock(publicationMutex);
    publicationCv.wait(lock, [&] { return joinAttempted; });
    allowCreate = true;
  }
  publicationCv.notify_all();

  creator.join();
  publicationJoiner.join();
  assert(createResult == 0);
  assert(publicationJoinResult == 0);
  assert(publicationCalls.load() == 1);
  assert(publicationOwner.state() == PthreadOwnershipState::None);

  OwnedPthread competingJoinOwner;
  BlockingWorkerContext blockingContext;
  assert(competingJoinOwner.Create(BlockingWorker, &blockingContext) == 0);
  {
    std::unique_lock<std::mutex> lock(blockingContext.mutex);
    blockingContext.cv.wait(lock, [&] { return blockingContext.started; });
  }

  std::mutex joinMutex;
  std::condition_variable joinCv;
  int readyJoiners = 0;
  bool joinNow = false;
  int joinResults[2] = {-1, -1};
  std::thread joiners[2];
  for (int i = 0; i < 2; ++i) {
    joiners[i] = std::thread([&, i] {
      {
        std::unique_lock<std::mutex> lock(joinMutex);
        ++readyJoiners;
        joinCv.notify_all();
        joinCv.wait(lock, [&] { return joinNow; });
      }
      joinResults[i] = competingJoinOwner.Join();
    });
  }

  {
    std::unique_lock<std::mutex> lock(joinMutex);
    joinCv.wait(lock, [&] { return readyJoiners == 2; });
    joinNow = true;
  }
  joinCv.notify_all();
  {
    std::lock_guard<std::mutex> lock(blockingContext.mutex);
    blockingContext.release = true;
  }
  blockingContext.cv.notify_all();

  for (auto& joiner : joiners) {
    joiner.join();
  }
  assert(joinResults[0] == 0);
  assert(joinResults[1] == 0);
  assert(blockingContext.calls.load() == 1);
  assert(competingJoinOwner.state() == PthreadOwnershipState::None);

  OwnedPthread selfJoinOwner;
  SelfJoinContext selfJoinContext;
  selfJoinContext.owner = &selfJoinOwner;
  assert(selfJoinOwner.Create(SelfJoinWorker, &selfJoinContext) == 0);
  {
    std::unique_lock<std::mutex> lock(selfJoinContext.mutex);
    selfJoinContext.cv.wait(lock, [&] { return selfJoinContext.completed; });
  }
  assert(selfJoinContext.result == EDEADLK);
  assert(selfJoinOwner.Join() == 0);
  assert(selfJoinOwner.state() == PthreadOwnershipState::None);

  return 0;
}
