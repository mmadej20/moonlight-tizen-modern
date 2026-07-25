# Tizen 9 build and bounded toolchain decisions

The production image builds a signed Tizen 9.0 WGT. Samsung Tizen Studio 6.1 and Samsung Emscripten 1.39.4.7 remain the compatibility boundary for the WASM Player and Samsung socket integration.

| Component | Selected version | Verification result |
| --- | --- | --- |
| Tizen target | 9.0 | Packaged `config.xml` declares `required_version="9.0"`. |
| Tizen Studio | 6.1 | Retained; the complete legacy builder compiled, signed, and packaged `Moonlight.wgt`. |
| Samsung Emscripten | 1.39.4.7 | Retained; the complete legacy builder completed successfully. |
| Node.js | 24.18.0 | Selected in `frontend-dependencies`; `npm ci --omit=dev --ignore-scripts` installs the lockfile. |
| jQuery | 4.0.0 | Selected with the approved npm integrity; WGT contains only `static/js/jquery-4.0.0.min.js`. |
| Python | Python 2 (`/usr/bin/python2`) | Retained. The Python 3 complete-builder probe failed when CMake invoked `/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/emcc -v`; the targeted reproduction below records the complete import failure. |
| OpenSSL | Samsung-pinned 1.1.1d | Retained. The OpenSSL 3.5.7 probe verified the required SHA-256, then failed at `/home/moonlight/.emscripten_ports/crypto/openssl-3.5.7/crypto/include/internal/bn_conf.h`. |

Commands used for the toolchain decisions:

```powershell
rtk docker build --progress=plain --target builder -t moonlight-tizen-toolchain-inspect .
rtk docker build --progress=plain --target builder -f Dockerfile.modern-probe -t moonlight-tizen-python3-probe .
rtk docker run --rm --entrypoint /bin/bash moonlight-tizen-toolchain-inspect -lc "grep -nE '1\\.1\\.1|URL|HASH|patch|Configure' /home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/ports/tizen/ssl.py /home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/ports/tizen/crypto.py"
rtk docker build --progress=plain --target builder -f Dockerfile.modern-probe -t moonlight-tizen-openssl357-probe .
```

### Python 3 probe evidence

The temporary probe changed only:

```diff
-	python2 \
+	python3 \
-RUN ln -sf /usr/bin/python2 /usr/bin/python
+RUN ln -sf /usr/bin/python3 /usr/bin/python
+RUN python --version
```

The complete builder command was:

```powershell
rtk docker build --progress=plain --target builder -f Dockerfile.modern-probe -t moonlight-tizen-python3-probe .
```

The failing Docker command and CMake result were:

```text
RUN cmake -DCMAKE_TOOLCHAIN_FILE=/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/cmake/Modules/Platform/Emscripten.cmake -DCMAKE_C_COMPILER_LAUNCHER=ccache -DCMAKE_CXX_COMPILER_LAUNCHER=ccache -G Ninja -S moonlight-tizen -B build
CMake Error at /home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/cmake/Modules/Platform/Emscripten.cmake:100 (message):
  Failed to fetch compiler version information with command
  "'/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/emcc'
  -v"! Process returned with error code 1.
Call Stack (most recent call first):
  /usr/share/cmake-3.22/Modules/CMakeDetermineSystem.cmake:124 (include)
  CMakeLists.txt:3 (project)
```

A targeted reproduction against the successful inspection image used:

```powershell
rtk docker run --rm --user root --entrypoint /bin/bash moonlight-tizen-toolchain-inspect -lc "apt-get update >/dev/null && apt-get install -y python3 >/dev/null && ln -sf /usr/bin/python3 /usr/bin/python && runuser -u moonlight -- /home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/emcc -v"
```

It produced the full relevant trace:

```text
Traceback (most recent call last):
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/emcc.py", line 41, in <module>
    import emscripten
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/emscripten.py", line 24, in <module>
    from tools import shared
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/shared.py", line 8, in <module>
    from distutils.spawn import find_executable
ModuleNotFoundError: No module named 'distutils.spawn'
```

### OpenSSL 3.5.7 probe evidence

The probe used the official source URL
`https://www.openssl.org/source/openssl-3.5.7.tar.gz`. It verified the
archive before building:

```text
RUN echo 'a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8  openssl-3.5.7.tar.gz' | sha256sum -c -
openssl-3.5.7.tar.gz: OK
```

The temporary Samsung port metadata delta was:

```text
TAG: '3.5.7'
URL expression: 'https://www.openssl.org/source/openssl-' + TAG + '.tar.gz'
HASH: 'de5351d2d532e1a3908a738f7d8aae448d32bc60bdb24808c556a24bc37a3f53daedf12b5d432eeb8c235e16939d842f908332ede8a447ca103ad1c493c820d7'
```

`HASH` is the SHA-512 value required by Samsung Emscripten's
`ports.fetch_project()` implementation; the explicit command above separately
enforced the approved SHA-256.

The complete builder command was:

```powershell
rtk docker build --progress=plain --target builder -f Dockerfile.modern-probe -t moonlight-tizen-openssl357-probe .
```

The failing Docker command and full relevant trace were:

```text
CCACHE_DIR=/home/moonlight/.ccache cmake --build build
Traceback (most recent call last):
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/emcc.py", line 2883, in <module>
    sys.exit(run(sys.argv))
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/emcc.py", line 2096, in run
    extra_files_to_link = system_libs.get_ports(shared.Settings)
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/system_libs.py", line 1850, in get_ports
    ret += [f for f in port.get(Ports, settings, shared) if not f.endswith('.txt')]
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/ports/tizen/crypto.py", line 721, in get
    return [shared.Cache.get(libname, create, what='port')]
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/cache.py", line 133, in get
    temp = creator()
  File "/home/moonlight/emscripten-release-bundle/emsdk/fastcomp/emscripten/tools/ports/tizen/crypto.py", line 685, in create
    open(os.path.join(source_path, *header[0]), 'w').write(header[1])
IOError: [Errno 2] No such file or directory: '/home/moonlight/.emscripten_ports/crypto/openssl-3.5.7/crypto/include/internal/bn_conf.h'
ninja: build stopped: subcommand failed.
```

No TLS validation/security flag was weakened and no compatibility source patch
was accepted. The temporary `Dockerfile.modern-probe` was deleted after the
probes.

### Artifact-only release extraction

`release-development.yml` and `release-stable.yml` create a stopped container
with `docker create --name temp_container $IMAGE_TAG artifact-only`, copy the
WGT with `docker cp`, and remove the stopped container with `docker rm`. They
never start the scratch image. `release-usb.yml` remains unchanged because it
is separately unsupported and outside this task.

Legacy build dependencies are isolated inside the Docker builder only; they are not TV runtime components. The default final stage is `scratch` and copies only `/home/moonlight/Moonlight.wgt` from `builder`.

## Produced artifact

- Path: `C:\Users\madej\Downloads\moonlight-tizen-master\Moonlight.wgt`
- Size: 2,317,301 bytes
- Timestamp (UTC): 2026-07-25 20:44:03
- SHA-256: `86968C3DB957A6DAD53E01E81D284FF8D300BF08673482D3D5CE62B96F5251AC`

The package contains signature files, Tizen `config.xml`, WASM/worker/platform assets, the curl CA bundle, icons, and `static/js/jquery-4.0.0.min.js`. It does not contain jQuery 2.2.0, `node_modules`, tests, Dockerfiles, SDK files, source files, or private keys.

This is the final Task 10 artifact from committed source
`7eff49d7a2118533c8081f3a2ad944f408514cf8`. It was produced by a clean,
uncached default Docker build of `moonlight-tizen-9-reliability`, copied from
a uniquely named container while its state was `created|false`, and inspected
after extraction. All 12 native test executables passed with the documented
warning, sanitizer, and pthread options; all 13 JavaScript suites passed; and
the receiver integration test printed its PASS marker. Package inspection
confirmed Tizen 9.0, both signatures, the required runtime/browser assets, and
the absence of forbidden entries and unresolved old-jQuery references.

## Physical TV smoke checklist (not yet performed)

1. Install and launch on a Samsung UE43CU7172UXXH running Tizen 9.0.
2. Add a host, cancel once, then add successfully.
3. Pair, cancel once, then pair successfully.
4. Confirm automatic `/24` discovery finds the host without UI stalls.
5. Load populated and empty app lists.
6. Connect, disconnect, and reconnect a controller.
7. Verify buttons, axes, rumble, and the stop-stream combo.
8. Stream H.264 and the TV-supported HEVC/AV1 modes.
9. Compare frame pacing disabled and enabled at 60 FPS.
10. Stop, remote-terminate, and reconnect repeatedly.
11. Leave media setup during startup and confirm no hang.
12. Export diagnostics after the session.
