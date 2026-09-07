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

#include "../libgamestream/http_context.h"

#include <memory>
#include <mutex>
#include <unordered_map>

class HttpRequestRegistry {
 public:
  std::shared_ptr<HTTP_REQUEST_CONTEXT> Create(int callback_id,
                                               long connect_timeout_ms,
                                               long total_timeout_ms) {
    auto context = std::make_shared<HTTP_REQUEST_CONTEXT>();
    // A zero transfer deadline is the pairing policy: the host may wait for
    // user input without sending any bytes. Keep the connection deadline and
    // cancellation active, but do not let the ordinary low-speed limit end it.
    const bool waitingForUser = total_timeout_ms == 0;
    http_request_context_init(context.get(), connect_timeout_ms,
                              total_timeout_ms, waitingForUser ? 0 : 2,
                              waitingForUser ? 0 : 1);

    std::lock_guard<std::mutex> lock(m_Mutex);
    if (m_Requests.find(callback_id) != m_Requests.end())
      return nullptr;

    m_Requests.emplace(callback_id, context);
    return context;
  }

  bool Cancel(int callback_id) {
    std::shared_ptr<HTTP_REQUEST_CONTEXT> context;
    {
      std::lock_guard<std::mutex> lock(m_Mutex);
      auto request = m_Requests.find(callback_id);
      if (request == m_Requests.end())
        return false;
      context = request->second;
    }

    http_cancel_request(context.get());
    return true;
  }

  void Remove(int callback_id) {
    std::lock_guard<std::mutex> lock(m_Mutex);
    m_Requests.erase(callback_id);
  }

  size_t Size() const {
    std::lock_guard<std::mutex> lock(m_Mutex);
    return m_Requests.size();
  }

 private:
  mutable std::mutex m_Mutex;
  std::unordered_map<int, std::shared_ptr<HTTP_REQUEST_CONTEXT>> m_Requests;
};
