#include "libgamestream/http_context.h"

#include <assert.h>

int main(void) {
  HTTP_REQUEST_CONTEXT context;
  http_request_context_init(&context, 3000, 5000, 2, 1);
  assert(!http_request_is_cancelled(&context));
  assert(context.connect_timeout_ms == 3000);
  assert(context.total_timeout_ms == 5000);
  http_cancel_request(&context);
  assert(http_request_is_cancelled(&context));

  // The timing of a request is filled in by the request itself and starts out empty
  assert(context.timing_valid == 0);
  assert(context.timing_namelookup_ms == 0 && context.timing_connect_ms == 0 && context.timing_appconnect_ms == 0);
  assert(context.timing_starttransfer_ms == 0 && context.timing_total_ms == 0);
  context.timing_valid = 1;
  context.timing_total_ms = 1234;
  http_request_context_init(&context, 3000, 5000, 2, 1);
  assert(context.timing_valid == 0 && context.timing_total_ms == 0);
  return 0;
}
