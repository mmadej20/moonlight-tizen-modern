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

#include "http_buffer.h"

#include "errors.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

int http_data_checked_size(size_t current_size, size_t size, size_t nmemb,
                           size_t* next_size) {
  size_t append_size;
  size_t result;

  if (size != 0 && nmemb > SIZE_MAX / size)
    return GS_RESPONSE_TOO_LARGE;

  append_size = size * nmemb;
  if (append_size > SIZE_MAX - current_size)
    return GS_RESPONSE_TOO_LARGE;

  result = current_size + append_size;
  if (result == SIZE_MAX)
    return GS_RESPONSE_TOO_LARGE;

  if (next_size != NULL)
    *next_size = result;

  return GS_OK;
}

PHTTP_DATA http_create_data(size_t max_size) {
  PHTTP_DATA data = malloc(sizeof(*data));
  if (data == NULL)
    return NULL;

  data->memory = malloc(1);
  if (data->memory == NULL) {
    free(data);
    return NULL;
  }

  data->memory[0] = '\0';
  data->size = 0;
  data->max_size = max_size;
  data->error = GS_OK;
  return data;
}

int http_data_append(PHTTP_DATA data, const void* contents, size_t size) {
  size_t next_size;
  char* next_memory;
  int result;

  if (data == NULL || (contents == NULL && size != 0))
    return GS_INVALID;

  result = http_data_checked_size(data->size, 1, size, &next_size);
  if (result != GS_OK || next_size > data->max_size) {
    data->error = GS_RESPONSE_TOO_LARGE;
    return GS_RESPONSE_TOO_LARGE;
  }

  next_memory = realloc(data->memory, next_size + 1);
  if (next_memory == NULL) {
    data->error = GS_OUT_OF_MEMORY;
    return GS_OUT_OF_MEMORY;
  }

  data->memory = next_memory;
  if (size != 0)
    memcpy(data->memory + data->size, contents, size);
  data->size = next_size;
  data->memory[data->size] = '\0';
  return GS_OK;
}

void http_free_data(PHTTP_DATA data) {
  if (data != NULL) {
    free(data->memory);
    free(data);
  }
}
