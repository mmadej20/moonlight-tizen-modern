// Address of the lock word of the allocator in the module. The Docker build overwrites this file with the address that
// tools/find-malloc-lock.js finds in the linked module; 0 means that the guard of futex_guard.js does nothing (a
// build outside Docker has no such module).
var MALLOC_LOCK_WORD_ADDRESS = 0;
