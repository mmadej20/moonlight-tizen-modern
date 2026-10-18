/*
 * This file is part of Moonlight Embedded.
 *
 * Copyright (C) 2015 Iwan Timmer
 *
 * Moonlight is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3 of the License, or
 * (at your option) any later version.
 *
 * Moonlight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Moonlight; if not, see <http://www.gnu.org/licenses/>.
 */

#include "http.h"
#include "errors.h"

#include <string.h>
#include <curl/curl.h>

#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#include <openssl/pem.h>

extern X509 *g_Cert;
extern EVP_PKEY *g_PrivateKey;

static size_t _write_curl(void *contents, size_t size, size_t nmemb, void *userp)
{
  size_t next_size;
  size_t append_size;
  int result;
  PHTTP_DATA mem = (PHTTP_DATA)userp;

  result = http_data_checked_size(mem->size, size, nmemb, &next_size);
  if (result != GS_OK) {
    mem->error = result;
    return 0;
  }

  append_size = next_size - mem->size;
  result = http_data_append(mem, contents, append_size);
  if (result != GS_OK)
    return 0;

  return append_size;
}

static CURLcode sslctx_function(CURL * curl, void * sslctx, void * parm)
{
    (void)curl;
    (void)parm;
    SSL_CTX* ctx = (SSL_CTX*)sslctx;
    
    if(!SSL_CTX_use_certificate(ctx, g_Cert))
        printf("SSL_CTX_use_certificate problem\n");
    
    if(!SSL_CTX_use_PrivateKey(ctx, g_PrivateKey))
        printf("Use Key failed\n");
    
    return CURLE_OK;
}

static int _progress_callback(void *clientp, double dltotal, double dlnow, double ultotal, double ulnow) {
  PHTTP_REQUEST_CONTEXT context = (PHTTP_REQUEST_CONTEXT)clientp;
  (void)dltotal;
  (void)dlnow;
  (void)ultotal;
  (void)ulnow;
  return http_request_is_cancelled(context) ? 1 : 0;
}

int http_request(const char* url, const char* ppkstr,
                 PHTTP_REQUEST_CONTEXT context, PHTTP_DATA data) {
  int ret;
  CURL *curl;
  const char* real_url = url;
  char* rewritten_url = NULL;
  char* resolve_string = NULL;
  struct curl_slist *resolve_list = NULL;

  if (url == NULL || context == NULL || data == NULL)
    return GS_INVALID;
  if (http_request_is_cancelled(context))
    return GS_CANCELLED;

  curl = curl_easy_init();
  if (curl == NULL)
    return GS_OUT_OF_MEMORY;

  curl_easy_setopt(curl, CURLOPT_CAINFO, "/curl/ca-bundle.crt");
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, _write_curl);
  curl_easy_setopt(curl, CURLOPT_FAILONERROR, 1L);
  curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(curl, CURLOPT_PROGRESSFUNCTION, _progress_callback);
  curl_easy_setopt(curl, CURLOPT_PROGRESSDATA, context);
  curl_easy_setopt(curl, CURLOPT_SSL_CTX_FUNCTION, *sslctx_function);
  curl_easy_setopt(curl, CURLOPT_SSL_SESSIONID_CACHE, 0L);
  curl_easy_setopt(curl, CURLOPT_MAXCONNECTS, 0L);
  curl_easy_setopt(curl, CURLOPT_FRESH_CONNECT, 1L);
  curl_easy_setopt(curl, CURLOPT_FORBID_REUSE, 1L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, context->connect_timeout_ms);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, context->total_timeout_ms);
  curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, context->low_speed_time_seconds);
  curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, context->low_speed_bytes_per_second);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_SSL_ENABLE_ALPN, 0L);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, data);

  const char* bracket_start = strchr(url, '[');
  const char* bracket_end = strchr(url, ']');

  if (bracket_start != NULL && bracket_end != NULL && bracket_end > bracket_start) {
    int ipv6_len = bracket_end - bracket_start - 1;
    char ipv6_raw[128] = {0};
    if (ipv6_len < sizeof(ipv6_raw)) {
      strncpy(ipv6_raw, bracket_start + 1, ipv6_len);
    }
    
    const char* port_and_path = bracket_end + 1;
    
    int scheme_len = bracket_start - url;
    char scheme[32] = {0};
    if (scheme_len < sizeof(scheme)) {
      strncpy(scheme, url, scheme_len);
    }

    int port = 80;
    if (port_and_path[0] == ':') {
      port = atoi(port_and_path + 1);
    } else if (strncmp(scheme, "https://", 8) == 0) {
      port = 443;
    }

    const char* dummy_host = "moonlight-ipv6-host";
    rewritten_url = malloc(strlen(url) + strlen(dummy_host) + 1);
    sprintf(rewritten_url, "%s%s%s", scheme, dummy_host, port_and_path);

    resolve_string = malloc(strlen(dummy_host) + strlen(ipv6_raw) + 32);
    sprintf(resolve_string, "%s:%d:%s", dummy_host, port, ipv6_raw);

    resolve_list = curl_slist_append(NULL, resolve_string);
    curl_easy_setopt(curl, CURLOPT_RESOLVE, resolve_list);
    
    real_url = rewritten_url;
  }

  curl_easy_setopt(curl, CURLOPT_URL, real_url);

  // Use the pinned certificate for HTTPS
  if (ppkstr != NULL) {
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_PINNEDPUBLICKEY, ppkstr);
  }

  if (data->size > 0) {
    char* empty_memory = malloc(1);
    if (empty_memory == NULL) {
      ret = GS_OUT_OF_MEMORY;
      goto cleanup;
    }

    empty_memory[0] = '\0';
    free(data->memory);
    data->memory = empty_memory;
    data->size = 0;
  }
  data->error = GS_OK;

  CURLcode res = curl_easy_perform(curl);

  // Where the time went, in milliseconds: curl measures the stages, also for a request that failed
  {
    double namelookup = 0, connect = 0, appconnect = 0, starttransfer = 0, total = 0;
    curl_easy_getinfo(curl, CURLINFO_NAMELOOKUP_TIME, &namelookup);
    curl_easy_getinfo(curl, CURLINFO_CONNECT_TIME, &connect);
    curl_easy_getinfo(curl, CURLINFO_APPCONNECT_TIME, &appconnect);
    curl_easy_getinfo(curl, CURLINFO_STARTTRANSFER_TIME, &starttransfer);
    curl_easy_getinfo(curl, CURLINFO_TOTAL_TIME, &total);
    context->timing_namelookup_ms = (long)(namelookup * 1000.0 + 0.5);
    context->timing_connect_ms = (long)(connect * 1000.0 + 0.5);
    context->timing_appconnect_ms = (long)(appconnect * 1000.0 + 0.5);
    context->timing_starttransfer_ms = (long)(starttransfer * 1000.0 + 0.5);
    context->timing_total_ms = (long)(total * 1000.0 + 0.5);
    context->timing_valid = 1;
  }

  printf("CURL request completed: %s\n", curl_easy_strerror(res));
  
  if (data->error == GS_RESPONSE_TOO_LARGE) {
    ret = GS_RESPONSE_TOO_LARGE;
  } else if (data->error == GS_OUT_OF_MEMORY) {
    ret = GS_OUT_OF_MEMORY;
  } else if (res == CURLE_ABORTED_BY_CALLBACK &&
             http_request_is_cancelled(context)) {
    ret = GS_CANCELLED;
  } else if (res == CURLE_OPERATION_TIMEDOUT) {
    ret = GS_TIMEOUT;
  } else if (res == CURLE_SSL_PINNEDPUBKEYNOTMATCH) {
    ret = GS_CERT_MISMATCH;
  } else if (res != CURLE_OK) {
    ret = GS_FAILED;
  } else if (data->memory == NULL) {
    ret = GS_OUT_OF_MEMORY;
  } else {
    ret = GS_OK;
  }
  
cleanup:
  if (rewritten_url) free(rewritten_url);
  if (resolve_string) free(resolve_string);
  if (resolve_list) curl_slist_free_all(resolve_list);
  curl_easy_cleanup(curl);
  return ret;
}
