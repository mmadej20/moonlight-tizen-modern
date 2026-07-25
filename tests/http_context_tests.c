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
  return 0;
}
