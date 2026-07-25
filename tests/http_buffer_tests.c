#include "libgamestream/errors.h"
#include "libgamestream/http_buffer.h"

#include <assert.h>
#include <string.h>

int main(void) {
  HTTP_DATA* data = http_create_data(8);
  assert(data != NULL);
  assert(http_data_append(data, "abcd", 4) == GS_OK);
  assert(http_data_append(data, "efgh", 4) == GS_OK);
  assert(data->size == 8);
  assert(memcmp(data->memory, "abcdefgh", 8) == 0);
  assert(data->memory[8] == '\0');
  assert(http_data_append(data, "i", 1) == GS_RESPONSE_TOO_LARGE);
  assert(data->size == 8);
  http_free_data(data);

  assert(http_data_checked_size((size_t)-1, 2, 8, NULL) == GS_RESPONSE_TOO_LARGE);
  return 0;
}
