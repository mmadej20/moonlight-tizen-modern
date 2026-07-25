#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int gs_decode_hex_exact(const char* source, size_t source_length,
                        unsigned char* destination, size_t destination_capacity);
int gs_decode_hex_alloc(const char* source, size_t source_length,
                        size_t maximum_decoded_size,
                        unsigned char** destination, size_t* destination_size);

#ifdef __cplusplus
}
#endif
