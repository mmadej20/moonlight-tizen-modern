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

#include "http_context.h"

void http_request_context_init(PHTTP_REQUEST_CONTEXT context,
                               long connect_timeout_ms,
                               long total_timeout_ms,
                               long low_speed_time_seconds,
                               long low_speed_bytes_per_second) {
  context->connect_timeout_ms = connect_timeout_ms;
  context->total_timeout_ms = total_timeout_ms;
  context->low_speed_time_seconds = low_speed_time_seconds;
  context->low_speed_bytes_per_second = low_speed_bytes_per_second;
  context->timing_valid = 0;
  context->timing_namelookup_ms = 0;
  context->timing_connect_ms = 0;
  context->timing_appconnect_ms = 0;
  context->timing_starttransfer_ms = 0;
  context->timing_total_ms = 0;
  __atomic_store_n(&context->cancelled, 0, __ATOMIC_RELEASE);
}

void http_cancel_request(PHTTP_REQUEST_CONTEXT context) {
  __atomic_store_n(&context->cancelled, 1, __ATOMIC_RELEASE);
}

int http_request_is_cancelled(const HTTP_REQUEST_CONTEXT* context) {
  return __atomic_load_n(&context->cancelled, __ATOMIC_ACQUIRE);
}
