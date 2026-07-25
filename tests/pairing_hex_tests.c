#include "libgamestream/errors.h"
#include "libgamestream/hex_utils.h"

#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
  uint8_t output[4] = {0xAA, 0xAA, 0xAA, 0xAA};
  assert(gs_decode_hex_exact("0011aAfF", 8, output, sizeof(output)) == GS_OK);
  assert(output[0] == 0x00 && output[1] == 0x11);
  assert(output[2] == 0xAA && output[3] == 0xFF);

  memset(output, 0xAA, sizeof(output));
  assert(gs_decode_hex_exact("0011", 4, output, sizeof(output)) == GS_INVALID);
  assert(gs_decode_hex_exact("0011223344", 10, output, sizeof(output)) == GS_INVALID);
  assert(gs_decode_hex_exact("0011zzff", 8, output, sizeof(output)) == GS_INVALID);
  assert(gs_decode_hex_exact("0011aaf", 7, output, sizeof(output)) == GS_INVALID);
  assert(output[0] == 0xAA);

  unsigned char* allocated = NULL;
  size_t allocated_size = 0;
  assert(gs_decode_hex_alloc("414243", 6, 3, &allocated, &allocated_size) == GS_OK);
  assert(allocated_size == 3 && memcmp(allocated, "ABC", 3) == 0);
  free(allocated);
  allocated = NULL;
  assert(gs_decode_hex_alloc("41424344", 8, 3, &allocated, &allocated_size) == GS_INVALID);
  assert(allocated == NULL);
  return 0;
}
