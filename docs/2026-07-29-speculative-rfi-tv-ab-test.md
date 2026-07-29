# Speculative RFI recovery — TV A/B test

## Artifact

- File: `Moonlight-legacy-rfi-toggle.wgt`
- SHA-256: `A920D48F9696B472B83E5A94BE7FEC97569FFB5881F4B714CDDD4486458C91E3`
- Tizen required version: `5.5`
- Frontend compatibility dependency: jQuery `2.2.0`
- Setting location: Settings → Advanced Settings →
  `Speculative RFI recovery (experimental)`
- Default: disabled
- The setting takes effect when the next stream starts.

## What the setting does

The old speculative-RFI implementation could report predicted loss while the
renderer did not advertise RFI support. The current implementation never
bypasses that safety gate.

When the switch is enabled, the renderer advertises the capability matching the
selected codec before the Moonlight connection starts:

| Mode | Expected renderer capability |
|---|---:|
| Disabled | `0x04000000` |
| H.264 enabled | `0x04000002` |
| HEVC enabled | `0x04000004` |
| AV1 enabled | `0x04000040` |

The `0x04000000` part is the pre-existing four-slices-per-frame capability.

At the beginning of every session, verify these entries:

```text
Experimental RFI recovery: enabled
Experimental RFI recovery requested: enabled
Decoder renderer capabilities: 0x4000004 (RFI recovery enabled)
```

The first line is in the JavaScript session header. The next two are native
logs. For HEVC with the switch disabled, the corresponding values must be
`disabled` and `0x4000000`.

## Comparable test runs

Use the same:

- host and game;
- wired/Wi-Fi path;
- resolution, frame rate, bitrate, codec, and HDR mode;
- session duration and a similar workload.

Run at least one session with the switch disabled and one enabled. Restart the
stream after changing the switch; restarting the whole application is not
required.

Compare:

1. `Unrecoverable frame` / corrupt-frame count.
2. IDR request count and spacing.
3. Time between the first loss event and the first normal decoded frame.
4. Visible freezes, block corruption, color corruption, or decoder stalls.
5. Whether audio continues while video is frozen.
6. Network/FEC loss counters, to distinguish transport loss from recovery
   behavior.

## Interpreting the result

RFI does not prevent packets from being dropped and does not reconstruct
packets after FEC has failed. It can help after isolated video-frame losses by
avoiding a full IDR and invalidating a smaller reference range.

It is unlikely to improve:

- large bursts with tens or hundreds of consecutive unrecoverable frames;
- simultaneous audio/video pauses without a reported lost video frame;
- congestion or Wi-Fi interference itself.

Keep the setting disabled if the enabled run introduces a repeatable freeze,
long corruption, or decoder stall. A lower IDR count and shorter post-loss
recovery without those regressions would support enabling it for that TV and
codec combination.
