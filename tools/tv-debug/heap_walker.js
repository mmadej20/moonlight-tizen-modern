// Source of the in-page dlmalloc 2.8 chunk-chain walker (32-bit wasm heap of the Samsung fastcomp Emscripten 1.39).
// It is injected into the page and into every worker by forensics.js; it reads the shared heap only.
// __heapWalk({ start, maxBytes }) -> { ok, start, end, chunks, usedBytes, freeBytes, break: null | {...} }
// A chunk is { prev_foot:u32, head:u32, ... }; head = size | PINUSE(1) | CINUSE(2). The chain is consistent when every
// chunk's size is a multiple of 8, at least 16, ends inside the heap, and the next chunk's PINUSE equals this chunk's CINUSE.
// A free chunk also has its size repeated in the next chunk's prev_foot.
module.exports = `(function () {
  function view() {
    var u32 = (typeof HEAPU32 !== 'undefined' && HEAPU32) || (typeof Module !== 'undefined' && Module.HEAPU32);
    var u8 = (typeof HEAPU8 !== 'undefined' && HEAPU8) || (typeof Module !== 'undefined' && Module.HEAPU8);
    return { u32: u32, u8: u8 };
  }
  function hex(u8, from, count) {
    var out = [];
    for (var i = 0; i < count; i += 16) {
      var row = [];
      var ascii = '';
      for (var j = 0; j < 16 && i + j < count; j++) {
        var b = u8[from + i + j];
        row.push((b < 16 ? '0' : '') + b.toString(16));
        ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
      }
      out.push((from + i).toString(16).padStart(8, '0') + '  ' + row.join(' ') + '  ' + ascii);
    }
    return out.join('\\n');
  }
  // Returns the number of consecutive valid chunks from c (capped), used to find where the chain begins
  function probe(u32, c, top, cap) {
    var n = 0;
    while (n < cap) {
      var head = u32[(c + 4) >> 2];
      var size = head & ~7;
      if (size < 16 || c + size + 8 > top) return n;
      var next = u32[(c + size + 4) >> 2];
      if ((next & 1) !== ((head & 2) ? 1 : 0)) return n;
      c += size;
      n++;
    }
    return n;
  }
  var cachedStart = 0;
  return function (opts) {
    opts = opts || {};
    var v = view();
    var u32 = v.u32, u8 = v.u8;
    if (!u32 || typeof DYNAMICTOP_PTR === 'undefined') return { error: 'no heap view or DYNAMICTOP_PTR' };
    var top = u32[DYNAMICTOP_PTR >> 2];
    var base = (typeof DYNAMIC_BASE !== 'undefined') ? DYNAMIC_BASE : 0;
    var started = Date.now();
    var start = opts.start || cachedStart;
    if (!start) {
      var limit = Math.min(top, base + (opts.scanBytes || 8 * 1024 * 1024));
      for (var a = (base + 7) & ~7; a < limit; a += 8) {
        if (probe(u32, a, top, 24) >= 24) { start = a; break; }
      }
      if (!start) return { error: 'no chunk chain found', base: base, top: top };
      cachedStart = start;
    }
    var c = start, chunks = 0, used = 0, free = 0, prevs = [];
    var topFoot = 64;
    var result = { start: start, heapTop: top, ms: 0, chunks: 0, usedBytes: 0, freeBytes: 0, topChunk: 0, break: null };
    while (true) {
      var head = u32[(c + 4) >> 2];
      var size = head & ~7;
      var cinuse = (head & 2) !== 0;
      var pinuse = (head & 1) !== 0;
      var why = null;
      if (c + size + topFoot >= top && !cinuse) {
        // The top chunk: it ends where the heap's top foot starts
        result.topChunk = c;
        result.topSize = size;
        break;
      }
      if (size < 16) why = 'size below 16';
      else if (c + size > top) why = 'chunk ends beyond the heap top';
      else {
        var nextHead = u32[(c + size + 4) >> 2];
        if (((nextHead & 1) !== 0) !== cinuse) why = 'next PINUSE does not match this CINUSE';
        else if (!cinuse && u32[(c + size) >> 2] !== size) why = 'free chunk footer differs from its size';
      }
      if (why) {
        var dumpFrom = Math.max(start, (prevs.length ? prevs[prevs.length - 1].addr : c) - 32) & ~15;
        result.break = {
          reason: why, at: c, head: head, size: size, cinuse: cinuse, pinuse: pinuse,
          previous: prevs.slice(-6),
          dump: hex(u8, dumpFrom, Math.min(512, c + 160 - dumpFrom)),
          tailOfPrevious: prevs.length ? hex(u8, Math.max(0, c - 64), 64) : null
        };
        break;
      }
      prevs.push({ addr: c, size: size, free: !cinuse });
      if (prevs.length > 8) prevs.shift();
      if (cinuse) used += size; else free += size;
      chunks++;
      c += size;
      if (opts.maxMs && (chunks & 4095) === 0 && Date.now() - started > opts.maxMs) { result.timedOut = true; break; }
    }
    result.chunks = chunks;
    result.usedBytes = used;
    result.freeBytes = free;
    result.ms = Date.now() - started;
    return result;
  };
})()`;
