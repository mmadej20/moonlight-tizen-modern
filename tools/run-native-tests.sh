#!/usr/bin/env bash
# Builds and runs the native C/C++ suites in tests/ with ASan/UBSan.
# Run it from Linux or WSL (Ubuntu with g++ 13+); the WASM sources themselves only
# compile inside the Docker build, so these suites cover the host-compilable logic.
#
# Usage: tools/run-native-tests.sh [repo-root] [output-dir]
#   repo-root   defaults to the current directory
#   output-dir  defaults to a fresh mktemp directory (nothing is deleted)
#
# Exit status is non-zero when any non-skipped suite fails to build or run.
set -u
ROOT="${1:-$PWD}"
OUT="${2:-$(mktemp -d /tmp/moonlight-native-tests.XXXXXX)}"
mkdir -p "$OUT"
cd "$ROOT" || exit 2

# These suites are driven from outside and cannot run standalone:
#   http_pairing_integration_tests  needs a loopback server URL and a mode argument
#   request_registry_tests          needs g_Cert/g_PrivateKey provided by the pairing harness
#   web_audio_decode_tests          needs libopus built for the host
SKIP=" http_pairing_integration_tests request_registry_tests web_audio_decode_tests "

pass=0; fail=0; skip=0
for t in tests/*_tests.cpp tests/*_tests.c; do
  [ -e "$t" ] || continue
  name=$(basename "$t"); name="${name%.*}"
  case "$SKIP" in *" $name "*) echo "SKIP  $name (needs external driver)"; skip=$((skip+1)); continue ;; esac

  case "$t" in
    *.cpp) cc=(g++ -std=c++17 -pthread) ;;
    *.c)   cc=(gcc -std=c11 -pthread) ;;
  esac
  extra=()
  case "$name" in
    diagnostic_log_tests) extra=(wasm/diagnostic_log.cpp) ;;
    http_buffer_tests)    extra=(libgamestream/http_buffer.c) ;;
    http_context_tests)   extra=(libgamestream/http_context.c) ;;
    pairing_hex_tests)    extra=(libgamestream/hex_utils.c) ;;
  esac

  # C sources are compiled separately as C so they can be linked into C++ suites.
  cobjs=(); cppsrcs=(); ok=1
  : > "$OUT/$name.build.log"
  for e in "${extra[@]}"; do
    case "$e" in
      *.c)
        o="$OUT/$(basename "$e" .c).o"
        gcc -std=gnu11 -pthread -fsanitize=address,undefined -I. -c "$e" -o "$o" 2>>"$OUT/$name.build.log" || ok=0
        cobjs+=("$o") ;;
      *) cppsrcs+=("$e") ;;
    esac
  done

  if [ $ok = 1 ] && "${cc[@]}" -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer -I. \
       "$t" "${cppsrcs[@]}" "${cobjs[@]}" -o "$OUT/$name" 2>>"$OUT/$name.build.log"; then
    if "$OUT/$name" >"$OUT/$name.run.log" 2>&1; then echo "PASS  $name"; pass=$((pass+1))
    else echo "FAIL(run)   $name (see $OUT/$name.run.log)"; fail=$((fail+1)); fi
  else
    echo "FAIL(build) $name (see $OUT/$name.build.log)"; fail=$((fail+1))
  fi
done
echo "native summary: pass=$pass fail=$fail skip=$skip (output: $OUT)"
[ "$fail" -eq 0 ]
