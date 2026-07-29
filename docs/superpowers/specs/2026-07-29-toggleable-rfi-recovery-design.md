# Toggleable RFI recovery for Tizen decoders

## Problem

The Tizen client previously performed speculative frame-loss notification even
though its decoder renderer did not advertise reference-frame invalidation
(RFI). A late packet could then invalidate otherwise usable reference state and
leave the stream waiting roughly two seconds for an IDR frame. The existing
policy fix correctly blocks speculative notification whenever negotiated RFI is
disabled.

That incident proves an implementation mismatch, not that the Samsung hardware
decoder itself cannot work with RFI. There is currently no way to opt into a
consistent RFI negotiation and test the decoder on the target TV.

## Existing behavior

- The renderer advertises `CAPABILITY_SLICES_PER_FRAME(4)` and no RFI bits.
- `isReferenceFrameInvalidationEnabled()` requires both a negotiated codec and
  the matching renderer capability.
- The RTP queue permits speculative loss notification only when that predicate
  is true.
- Diagnostic messages about entering speculative mode describe queue state;
  they do not prove that speculative RFI notification was active.

## Approaches considered

1. Always advertise RFI. Rejected because it would expose all users and
   potentially incompatible TVs to freezes or corruption.
2. Bypass the capability gate only for speculative notifications. Rejected
   because it recreates the original inconsistent implementation.
3. Add a persistent, opt-in Advanced setting that advertises the RFI capability
   matching the selected codec. Selected because it makes normal and
   speculative recovery use the same negotiated state and provides a safe A/B
   test.

## Design

Add an experimental `Speculative RFI recovery` switch to Advanced settings.
The switch is persisted, defaults to off, and takes effect when the next stream
starts. Its description warns that unsupported decoders may freeze or show
corruption.

Pass the setting through the JavaScript launch message to
`MoonlightInstance::StartStream`. After the selected video-format mask is known,
derive renderer capabilities with a pure helper:

- disabled: preserve the existing slice capability and add no RFI bits;
- H.264: add `CAPABILITY_REFERENCE_FRAME_INVALIDATION_AVC`;
- HEVC Main/Main10: add
  `CAPABILITY_REFERENCE_FRAME_INVALIDATION_HEVC`;
- AV1 Main8/Main10: add `CAPABILITY_REFERENCE_FRAME_INVALIDATION_AV1`;
- unknown format: preserve the existing capability unchanged.

Set the renderer callback capability before the connection thread starts. This
allows Moonlight Common to negotiate and gate definitive and speculative RFI
consistently. The default-off path is behaviorally identical to the current
release.

The session diagnostics must log whether experimental RFI recovery was requested
and the final renderer capability mask. This makes TV logs sufficient to prove
which A/B branch ran.

## Expected effect on packet drops

RFI cannot prevent network packet loss or repair data after FEC recovery has
failed. It may reduce the number of full IDR requests and shorten visual
recovery after isolated losses by invalidating only affected reference ranges.
It is unlikely to help large bursts containing many consecutive unrecoverable
frames, and it cannot help pauses where audio and video both stall without a
reported video-frame loss.

## Testing

- Native policy tests cover capability derivation for off, H.264, HEVC, AV1,
  and unknown formats.
- JavaScript wiring tests cover the Advanced control, persistence, defaults,
  both launch paths, and the native boundary.
- Existing speculative-RFI policy tests continue to prove that speculative
  notification remains impossible without negotiated RFI.
- The full JavaScript, native receiver, and packaging suites must pass.
- Produce a signed legacy-runtime WGT for A/B testing on the TV.

## TV test

Run comparable sessions with the setting off and on, using the same host,
codec, resolution, frame rate, and network path. Compare unrecoverable frame
losses, IDR request count, time from loss to resumed decoded frames, corruption,
and freezes. A freeze or sustained corruption with RFI enabled is sufficient to
keep the option disabled on that TV; a lower IDR count without regressions
supports enabling it for that configuration.
