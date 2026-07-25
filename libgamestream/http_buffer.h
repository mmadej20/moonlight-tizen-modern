/*
 * This file is part of Moonlight Embedded.
 *
 * Copyright (C) 2015 Iwan Timmer
 *
 * Moonlight is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 */

#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define HTTP_TEXT_MAX_BYTES (1024u * 1024u)
#define HTTP_BINARY_MAX_BYTES (8u * 1024u * 1024u)

typedef struct _HTTP_DATA {
  char* memory;
  size_t size;
  size_t max_size;
  int error;
} HTTP_DATA, *PHTTP_DATA;

PHTTP_DATA http_create_data(size_t max_size);
int http_data_checked_size(size_t current_size, size_t size, size_t nmemb,
                           size_t* next_size);
int http_data_append(PHTTP_DATA data, const void* contents, size_t size);
void http_free_data(PHTTP_DATA data);

#ifdef __cplusplus
}
#endif
