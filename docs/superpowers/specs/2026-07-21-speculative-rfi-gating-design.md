# Speculative RFI gating for Tizen decoders

## Problem

The captured 4K60 HEVC session shows an out-of-order video packet followed by 120 consecutive `Waiting for IDR frame` drops and an IDR request about 1.97 seconds later. The Tizen renderer does not advertise reference-frame invalidation support, but the RTP queue still performs speculative loss notification intended for RFI recovery. A late packet can therefore cause the depacketizer to discard valid reference state before loss is confirmed.

## Approaches considered

1. Gate speculative loss notification on `isReferenceFrameInvalidationEnabled()`. Selected because it changes only the unsafe prediction path.
2. Disable all speculative-mode state tracking when RFI is unavailable. This touches initialization and cooldown transitions unnecessarily.
3. Advertise HEVC RFI capability from the Samsung decoder. This is unsafe because the renderer has not demonstrated support for reference-frame invalidation.

## Design

Add a small, pure policy predicate for speculative RFI eligibility. Prediction is allowed only when:

- the frame has not already been reported lost;
- no recent out-of-order data was observed;
- reference-frame invalidation is enabled for the negotiated codec and decoder;
- missing shards exceed available recovery shards.

Use the predicate at the existing speculative `notifyFrameLost(..., true)` call site. Normal FEC reconstruction, out-of-order queuing, definitive frame-loss detection, non-speculative recovery, decoder error recovery, and IDR fallback remain unchanged.

## Testing

A native test must prove that speculative notification is rejected when RFI is unavailable and accepted for the existing valid RFI case. It also covers the pre-existing reported-loss, recent-OOS, and recoverable-with-FEC guards. The test must fail before the policy is implemented. All existing diagnostics, timing, JavaScript, receiver, Emscripten, and Tizen packaging checks must remain green.

The user approved this design by requesting the previously described speculative-RFI fix. The workspace remains local and no commit will be created.
