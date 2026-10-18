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

#ifdef __cplusplus
extern "C" {
#endif

typedef struct _HTTP_REQUEST_CONTEXT {
  volatile int cancelled;
  long connect_timeout_ms;
  long total_timeout_ms;
  long low_speed_time_seconds;
  long low_speed_bytes_per_second;

  // Filled in by http_request when it has run: the cumulative times that curl measured, in milliseconds
  int timing_valid;
  long timing_namelookup_ms;
  long timing_connect_ms;
  long timing_appconnect_ms;
  long timing_starttransfer_ms;
  long timing_total_ms;
} HTTP_REQUEST_CONTEXT, *PHTTP_REQUEST_CONTEXT;

void http_request_context_init(PHTTP_REQUEST_CONTEXT context,
                               long connect_timeout_ms,
                               long total_timeout_ms,
                               long low_speed_time_seconds,
                               long low_speed_bytes_per_second);
void http_cancel_request(PHTTP_REQUEST_CONTEXT context);
int http_request_is_cancelled(const HTTP_REQUEST_CONTEXT* context);

#ifdef __cplusplus
}
#endif
