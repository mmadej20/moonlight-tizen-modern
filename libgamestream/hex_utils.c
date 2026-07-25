#include "hex_utils.h"

#include "errors.h"

#include <stdlib.h>
#include <string.h>

static int hex_nibble(char value, unsigned char* decoded) {
    if (value >= '0' && value <= '9') {
        *decoded = (unsigned char)(value - '0');
        return GS_OK;
    }

    if (value >= 'a' && value <= 'f') {
        *decoded = (unsigned char)(value - 'a' + 10);
        return GS_OK;
    }

    if (value >= 'A' && value <= 'F') {
        *decoded = (unsigned char)(value - 'A' + 10);
        return GS_OK;
    }

    return GS_INVALID;
}

static int decode_hex(const char* source, size_t source_length,
                      unsigned char* destination) {
    for (size_t i = 0; i < source_length; i += 2) {
        unsigned char high;
        unsigned char low;

        if (hex_nibble(source[i], &high) != GS_OK ||
            hex_nibble(source[i + 1], &low) != GS_OK) {
            return GS_INVALID;
        }

        destination[i / 2] = (unsigned char)((high << 4) | low);
    }

    return GS_OK;
}

int gs_decode_hex_exact(const char* source, size_t source_length,
                        unsigned char* destination, size_t destination_capacity) {
    if (source == NULL || destination == NULL ||
        (source_length & 1) != 0 ||
        destination_capacity != source_length / 2) {
        return GS_INVALID;
    }

    unsigned char* decoded = malloc(destination_capacity == 0 ? 1 : destination_capacity);
    if (decoded == NULL) {
        return GS_OUT_OF_MEMORY;
    }

    int result = decode_hex(source, source_length, decoded);
    if (result == GS_OK) {
        memcpy(destination, decoded, destination_capacity);
    }

    free(decoded);
    return result;
}

int gs_decode_hex_alloc(const char* source, size_t source_length,
                        size_t maximum_decoded_size,
                        unsigned char** destination, size_t* destination_size) {
    if (destination == NULL || destination_size == NULL) {
        return GS_INVALID;
    }

    *destination = NULL;
    *destination_size = 0;

    if (source == NULL || (source_length & 1) != 0 ||
        source_length / 2 > maximum_decoded_size) {
        return GS_INVALID;
    }

    size_t decoded_size = source_length / 2;
    unsigned char* decoded = malloc(decoded_size == 0 ? 1 : decoded_size);
    if (decoded == NULL) {
        return GS_OUT_OF_MEMORY;
    }

    int result = decode_hex(source, source_length, decoded);
    if (result != GS_OK) {
        free(decoded);
        return result;
    }

    *destination = decoded;
    *destination_size = decoded_size;
    return GS_OK;
}
